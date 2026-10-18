// Harness of the WA Channel integration tests: the real core services (embedded, real database
// and Redis), the real WA Channel runtime (Redis, RabbitMQ publisher and wa.inbound consumer),
// signed webhook calls through app.inject, and capture queues on the test vhost for the events
// the service publishes (wa.message.received, wa.status.received, wa.reply.requested).
import { randomUUID } from 'node:crypto';

import {
  setupWaFixture,
  startCoreServices,
  type EmbeddedCoreServices,
  type WaFixture,
} from '@antre/core-services/testing';
import { parseEvent, type EventEnvelope } from '@antre/event-contracts';
import { EVENT_EXCHANGE, assertTopology } from '@antre/messaging';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { inject } from 'vitest';

import { loadConfig, type WaChannelConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { METRIC_NAMES } from '../src/metrics.js';
import { createRuntime, type WaChannelRuntime } from '../src/runtime.js';
import { WEBHOOK_PREFIX } from '../src/app.js';
import { signPayload } from '../src/webhook/signature.js';

export const CAPTURE = {
  inbound: 'it.wa.inbound.capture',
  statuses: 'it.wa.status.capture',
  replies: 'it.wa.reply.capture',
} as const;

export interface Harness {
  core: EmbeddedCoreServices;
  runtime: WaChannelRuntime;
  config: WaChannelConfig;
  channel: Channel;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const redisUrl = inject('redisUrl');
  const amqpUrl = inject('amqpUrl');
  const core = await startCoreServices({ databaseUrl: inject('databaseUrls').app, redisUrl });
  const config = loadConfig({
    ...process.env,
    CORE_SERVICES_URL: core.url,
    REDIS_URL: redisUrl,
    RABBITMQ_URL: amqpUrl,
    WA_INBOUND_RETRY_DELAYS_MS: '100,200,300',
    META_WA_PHONE_NUMBER_ID: '',
  });
  const runtime = createRuntime(config, silentLogger, {
    reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
    shutdownTimeoutMs: 5_000,
  });

  const model: ChannelModel = await connect(amqpUrl);
  const channel = await model.createChannel();
  await assertTopology(channel);
  const bindings: [string, string][] = [
    [CAPTURE.inbound, 'wa.message.received'],
    [CAPTURE.statuses, 'wa.status.received'],
    [CAPTURE.replies, 'wa.reply.requested'],
  ];
  for (const [queue, routingKey] of bindings) {
    // RabbitMQ 4 refuses transient non-exclusive queues; the vhost is deleted after the run.
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, EVENT_EXCHANGE, routingKey);
    await channel.purgeQueue(queue);
  }

  runtime.start();
  await runtime.app.ready();
  if (!(await runtime.publisher.waitUntilReady(10_000))) throw new Error('publisher not ready');
  if (!(await runtime.consumer.waitUntilReady(10_000))) throw new Error('consumer not ready');
  await waitFor(() => runtime.store.ready, 5_000, 'redis not ready');

  return {
    core,
    runtime,
    config,
    channel,
    close: async () => {
      await runtime.stop();
      await channel.close().catch(() => undefined);
      await model.close().catch(() => undefined);
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

/** Takes `count` events from a capture queue, waiting up to `timeoutMs`. */
export async function take(
  harness: Harness,
  queue: string,
  count: number,
  timeoutMs = 10_000,
): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count) {
    const message = await harness.channel.get(queue, { noAck: true });
    if (message === false) {
      if (Date.now() > deadline) {
        throw new Error(`expected ${count} events on ${queue}, got ${events.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    events.push(parseEvent(JSON.parse(message.content.toString('utf8'))));
  }
  return events;
}

/** Fails when a capture queue receives anything within `waitMs`. */
export async function expectNothing(harness: Harness, queue: string, waitMs = 500): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const message = await harness.channel.get(queue, { noAck: true });
  if (message !== false) {
    throw new Error(`unexpected event on ${queue}: ${message.content.toString('utf8')}`);
  }
}

export function newPhone(): string {
  return `628${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
}

export function newWamid(): string {
  return `wamid.IT${randomUUID().replace(/-/g, '')}`;
}

type MessageInput = { text: string } | { replyId: string; title?: string };

/** A Cloud API notification with one inbound message. */
export function messageNotification(
  from: string,
  input: MessageInput,
  wamid = newWamid(),
): Record<string, unknown> {
  const message =
    'text' in input
      ? { from, id: wamid, timestamp: '1792378800', type: 'text', text: { body: input.text } }
      : {
          from,
          id: wamid,
          timestamp: '1792378800',
          type: 'interactive',
          interactive: {
            type: 'list_reply',
            list_reply: { id: input.replyId, title: input.title ?? 'pilihan' },
          },
        };
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-IT',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '628100000000', phone_number_id: '1234567890' },
              contacts: [{ wa_id: from, profile: { name: 'Budi Santoso' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

/** POSTs `body` to the webhook, signed with the app secret unless `signature` is given. */
export async function postWebhook(harness: Harness, body: object, signature?: string) {
  const raw = JSON.stringify(body);
  return harness.runtime.app.inject({
    method: 'POST',
    url: `${WEBHOOK_PREFIX}/webhook`,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature ?? signPayload(raw, harness.config.appSecret),
    },
    payload: raw,
  });
}

/** Sends one customer message and returns the reply events it produced (0 or 1). */
export async function say(
  harness: Harness,
  from: string,
  input: MessageInput,
  expectReply = true,
): Promise<EventEnvelope<'wa.reply.requested'> | null> {
  const handled = () => harness.runtime.metrics.total(METRIC_NAMES.conversations);
  const before = handled();
  const response = await postWebhook(harness, messageNotification(from, input));
  if (response.statusCode !== 200) {
    throw new Error(`webhook answered ${response.statusCode}: ${response.body}`);
  }
  if (!expectReply) {
    await waitFor(() => handled() > before, 10_000, 'message not handled');
    await expectNothing(harness, CAPTURE.replies, 200);
    return null;
  }
  const [reply] = await take(harness, CAPTURE.replies, 1);
  return reply as EventEnvelope<'wa.reply.requested'>;
}

/** Ids of the buttons or list rows of a reply. */
export function optionIds(reply: EventEnvelope<'wa.reply.requested'> | null): string[] {
  const message = reply?.data.message;
  if (message?.kind === 'buttons') return message.buttons.map((button) => button.id);
  if (message?.kind === 'list') return message.rows.map((row) => row.id);
  return [];
}

export { setupWaFixture, type WaFixture };
