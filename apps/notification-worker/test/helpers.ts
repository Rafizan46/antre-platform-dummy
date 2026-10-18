// Shared helpers for the worker integration tests: a running worker (sandbox adapter) and a real
// publisher on the test vhost, tenants inserted as antre_app, queue inspection, and polling.
import { randomUUID } from 'node:crypto';

import type { EventEnvelope } from '@antre/event-contracts';
import {
  NOTIFICATIONS_DLQ,
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_RETRY_QUEUES,
  RabbitEventPublisher,
  assertTopology,
} from '@antre/messaging';
import { connect, type Channel, type ChannelModel, type GetMessage } from 'amqplib';
import pg from 'pg';
import { inject } from 'vitest';

import { withTransaction } from '../src/db.js';
import { silentLogger } from '../src/logger.js';
import { Metrics } from '../src/metrics.js';
import { SandboxMockAdapter } from '../src/whatsapp/sandbox.js';
import { NotificationWorker } from '../src/worker.js';

/** Short backoff for tests; production uses 5 s, 25 s, 125 s. */
export const TEST_RETRY_DELAYS_MS = [100, 200, 300];

export interface Harness {
  pool: pg.Pool;
  adapter: SandboxMockAdapter;
  metrics: Metrics;
  worker: NotificationWorker;
  publisher: RabbitEventPublisher;
  /** Raw channel for inspecting and purging queues. */
  inspect: Channel;
  publish(event: EventEnvelope): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(options: { startWorker?: boolean } = {}): Promise<Harness> {
  const amqpUrl = inject('amqpUrl');
  const pool = new pg.Pool({ connectionString: inject('databaseUrls').app, max: 10 });
  const adapter = new SandboxMockAdapter();
  const metrics = new Metrics();
  const worker = new NotificationWorker({
    pool,
    rabbitmqUrl: amqpUrl,
    adapter,
    templateLanguage: 'id',
    prefetch: 5,
    retryDelaysMs: TEST_RETRY_DELAYS_MS,
    log: silentLogger,
    metrics,
    reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
    shutdownTimeoutMs: 5_000,
  });
  const publisher = new RabbitEventPublisher({
    url: amqpUrl,
    name: 'test-publisher',
    log: silentLogger,
    reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
  });

  const model: ChannelModel = await connect(amqpUrl);
  const inspect = await model.createChannel();
  await assertTopology(inspect);

  publisher.start();
  if (!(await publisher.waitUntilReady(10_000))) throw new Error('publisher not connected');
  if (options.startWorker !== false) {
    worker.start();
    if (!(await worker.waitUntilReady(10_000))) throw new Error('worker not consuming');
  }

  return {
    pool,
    adapter,
    metrics,
    worker,
    publisher,
    inspect,
    publish: (event) => publisher.publish(event),
    close: async () => {
      await worker.stop();
      await publisher.close();
      await model.close();
      await pool.end();
    },
  };
}

export async function purgeQueues(inspect: Channel): Promise<void> {
  for (const queue of [NOTIFICATIONS_QUEUE, ...NOTIFICATIONS_RETRY_QUEUES, NOTIFICATIONS_DLQ]) {
    await inspect.purgeQueue(queue);
  }
}

export async function messageCount(inspect: Channel, queue: string): Promise<number> {
  return (await inspect.checkQueue(queue)).messageCount;
}

/** Takes (and acks) every message currently in `queue`. */
export async function drain(inspect: Channel, queue: string): Promise<GetMessage[]> {
  const messages: GetMessage[] = [];
  for (;;) {
    const message = await inspect.get(queue, { noAck: true });
    if (message === false) return messages;
    messages.push(message);
  }
}

export interface TestTenant {
  tenant: { id: string; name: string };
  location: { id: string; code: string };
}

/** Inserts a tenant and a location as antre_app in that tenant's context (RLS applies). */
export async function createTenant(
  pool: pg.Pool,
  options: { branding?: object; timezone?: string } = {},
): Promise<TestTenant> {
  const tenantId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  return withTransaction(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, slug, business_type, admin_wa_phone, branding)
       VALUES ($1, $2, $3, 'CLINIC', '6281111111111', $4)`,
      [tenantId, `Klinik ${suffix}`, `klinik-${suffix}`, JSON.stringify(options.branding ?? {})],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, code, name, timezone) VALUES ($1, 'pusat', 'Cabang Pusat', $2)
       RETURNING id`,
      [tenantId, options.timezone ?? 'Asia/Jakarta'],
    );
    return {
      tenant: { id: tenantId, name: `Klinik ${suffix}` },
      location: { id: rows[0]!.id, code: 'pusat' },
    };
  });
}

export interface LogRow {
  event_id: string;
  provider_message_id: string | null;
  recipient_phone: string;
  template_name: string | null;
  payload: Record<string, unknown>;
  delivery_status: string;
  retry_count: number;
  sent_at: Date | null;
  status_updated_at: Date | null;
}

/** notification_logs of `tenantId`, read in that tenant's context. */
export async function logsOf(pool: pg.Pool, tenantId: string): Promise<LogRow[]> {
  return withTransaction(pool, tenantId, async (client) => {
    const { rows } = await client.query<LogRow>(
      `SELECT event_id, provider_message_id, recipient_phone, template_name, payload,
              delivery_status, retry_count, sent_at, status_updated_at
       FROM notification_logs ORDER BY event_id`,
    );
    return rows;
  });
}

/** Polls `check` until it returns a non-undefined value or `timeoutMs` passes. */
export async function waitFor<T>(
  check: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
