// Harness of the realtime integration tests: the real core services (embedded, real database and
// Redis, realtime publishing on), the real gateway runtime on an ephemeral port, and a TCP proxy
// between the gateway and Redis so a test can take Redis away from the gateway only.
import net from 'node:net';

import {
  setupWaFixture,
  startCoreServices,
  type EmbeddedCoreServices,
  type WaFixture,
} from '@antre/core-services/testing';
import { inject } from 'vitest';

import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createRuntime, type RealtimeRuntime } from '../src/runtime.js';

/** Forwards a local port to Redis; stop() drops every connection and refuses new ones. */
export class TcpProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  async start(): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => undefined);
      }
      client.pipe(upstream).pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
    this.port = (server.address() as net.AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export interface Harness {
  core: EmbeddedCoreServices;
  runtime: RealtimeRuntime;
  proxy: TcpProxy;
  /** Base URL of the gateway. */
  url: string;
  tenantA: WaFixture;
  tenantB: WaFixture;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const redisUrl = inject('redisUrl');
  const core = await startCoreServices({
    databaseUrl: inject('databaseUrls').app,
    redisUrl,
    realtime: true,
  });
  const target = new URL(redisUrl);
  const proxy = new TcpProxy(target.hostname, Number(target.port || 6379));
  await proxy.start();
  const proxied = new URL(redisUrl);
  proxied.port = String(proxy.port);
  const config = loadConfig({
    ...process.env,
    REDIS_URL: proxied.toString(),
    REALTIME_HEARTBEAT_MS: '200',
    REALTIME_RETRY_MS: '200',
  });
  const runtime = createRuntime(config, silentLogger);
  runtime.start();
  const url = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
  await waitFor(() => runtime.store.ready, 10_000, 'gateway redis not ready');

  const tenantA = await setupWaFixture(core);
  const tenantB = await setupWaFixture(core);
  return {
    core,
    runtime,
    proxy,
    url,
    tenantA,
    tenantB,
    close: async () => {
      await runtime.stop();
      await proxy.stop();
      await core.close();
    },
  };
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function bearerToken(headers: Record<string, string>): string {
  return headers.authorization!.replace(/^Bearer /, '');
}

export function streamUrl(harness: Harness, locationId: string): string {
  return `${harness.url}/api/v1/realtime/locations/${locationId}/stream`;
}

let phoneSeq = Math.floor(Math.random() * 1e6) * 100;

/** A staff ticket with a WhatsApp number (PII the updates must not carry), then CALL_NEXT. */
export async function ticketAndCall(core: EmbeddedCoreServices, f: WaFixture) {
  const created = await core.app.inject({
    method: 'POST',
    url: '/api/v1/queues/tickets',
    headers: f.owner,
    payload: {
      location_id: f.locationId,
      service_id: f.serviceId,
      customer_name: 'Budi Santoso',
      customer_phone: `62812${String(++phoneSeq).padStart(8, '0')}`,
    },
  });
  if (created.statusCode !== 201) throw new Error(`ticket failed: ${created.body}`);
  const called = await core.app.inject({
    method: 'POST',
    url: '/api/v1/queues/tickets/call-next',
    headers: f.owner,
    payload: { location_id: f.locationId, service_id: f.serviceId, resource_id: f.resourceId },
  });
  if (called.statusCode !== 200) throw new Error(`call-next failed: ${called.body}`);
  const ticket = called.json<{ ticket: { ticket_number: string } | null }>().ticket;
  if (ticket === null) throw new Error('call-next found no ticket');
  return ticket;
}

export async function issueKioskToken(core: EmbeddedCoreServices, f: WaFixture): Promise<string> {
  const response = await core.app.inject({
    method: 'POST',
    url: `/api/v1/locations/${f.locationId}/kiosk-tokens`,
    headers: f.owner,
  });
  if (response.statusCode !== 201) throw new Error(`kiosk token failed: ${response.body}`);
  return response.json<{ token: string }>().token;
}
