// Isolation for the external services: a RabbitMQ vhost created and deleted through the management
// HTTP API (credentials from RABBITMQ_URL), a dedicated Redis logical database, a TCP proxy in
// front of the broker that the tests can cut, and free-port discovery. Only local hosts are
// accepted, because these helpers delete data.
import net from 'node:net';

import { createClient } from '@redis/client';

export const E2E_DATABASE = 'antre_e2e';
export const E2E_VHOST = 'antre_e2e';
/** Redis logical database of the E2E stack (dev stack: 0, db tests: 12 and 13). */
export const E2E_REDIS_DB = 11;

export function readLocalUrl(name: string): URL {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; run the tests with "pnpm e2e".`);
  }
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`${name} must point to 127.0.0.1 or localhost, got ${url.hostname}.`);
  }
  return url;
}

async function management(method: string, path: string, body?: object): Promise<Response> {
  const amqp = readLocalUrl('RABBITMQ_URL');
  const api = readLocalUrl('RABBITMQ_MANAGEMENT_URL');
  const user = decodeURIComponent(amqp.username);
  const password = decodeURIComponent(amqp.password);
  return fetch(`${api.protocol}//${api.host}/api${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function createVhost(vhost: string): Promise<void> {
  const name = encodeURIComponent(vhost);
  const created = await management('PUT', `/vhosts/${name}`, {});
  if (!created.ok) throw new Error(`create vhost ${vhost}: HTTP ${created.status}`);
  const user = decodeURIComponent(readLocalUrl('RABBITMQ_URL').username);
  const permitted = await management('PUT', `/permissions/${name}/${encodeURIComponent(user)}`, {
    configure: '.*',
    write: '.*',
    read: '.*',
  });
  if (!permitted.ok) throw new Error(`grant vhost ${vhost}: HTTP ${permitted.status}`);
}

export async function deleteVhost(vhost: string): Promise<void> {
  const response = await management('DELETE', `/vhosts/${encodeURIComponent(vhost)}`);
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete vhost ${vhost}: HTTP ${response.status}`);
  }
}

/** REDIS_URL pointed at the E2E database. */
export function e2eRedisUrl(): string {
  const url = readLocalUrl('REDIS_URL');
  url.pathname = `/${E2E_REDIS_DB}`;
  return url.toString();
}

/** Empties the E2E Redis database (FLUSHDB only ever runs on that database). */
export async function flushE2eRedis(): Promise<void> {
  const client = createClient({ url: e2eRedisUrl() });
  client.on('error', () => undefined);
  await client.connect();
  try {
    await client.flushDb();
  } finally {
    await client.close();
  }
}

/** A port that was free a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Forwards a local port to a target. stop() drops every connection and refuses new ones; start()
 * listens on the same port again, so services that reconnect find the target back.
 */
export class TcpProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  get running(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server !== null) return;
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
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', resolve);
    });
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

/** Deletes the WA conversation session of a number, as if it had expired (the 30 minute TTL). */
export async function dropWaSession(phone: string): Promise<number> {
  const client = createClient({ url: e2eRedisUrl() });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await client.del(`wa:conv:${phone}`);
  } finally {
    await client.close();
  }
}
