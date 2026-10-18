// Webhook behaviour against real Redis and RabbitMQ: verification, signature check, dedup per
// wamid, delivery statuses, and the dead-letter path of wa.inbound (S09).
import { HEADERS, WA_INBOUND_DLQ, WA_INBOUND_QUEUE } from '@antre/messaging';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WEBHOOK_PREFIX } from '../src/app.js';
import { KEYS } from '../src/store.js';
import { signPayload } from '../src/webhook/signature.js';
import {
  CAPTURE,
  createHarness,
  expectNothing,
  messageNotification,
  newPhone,
  newWamid,
  postWebhook,
  take,
  waitFor,
  type Harness,
} from './helpers.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  for (const queue of Object.values(CAPTURE)) await harness.channel.purgeQueue(queue);
  await harness.channel.purgeQueue(WA_INBOUND_DLQ);
});

describe('GET verification', () => {
  it('echoes hub.challenge only for the configured verify token', async () => {
    const ok = await harness.runtime.app.inject({
      method: 'GET',
      url: `${WEBHOOK_PREFIX}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(harness.config.verifyToken)}&hub.challenge=987654`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('987654');
    const wrong = await harness.runtime.app.inject({
      method: 'GET',
      url: `${WEBHOOK_PREFIX}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`,
    });
    expect(wrong.statusCode).toBe(403);
  });
});

describe('POST signature (NFR-SECU-02)', () => {
  it('rejects a wrong signature with 401: nothing is published, deduplicated, or answered', async () => {
    const wamid = newWamid();
    const body = messageNotification(newPhone(), { text: 'ANTRE x y' }, wamid);
    const response = await postWebhook(
      harness,
      body,
      signPayload(JSON.stringify(body), 'not-the-app-secret-000000'),
    );
    expect(response.statusCode).toBe(401);
    await expectNothing(harness, CAPTURE.inbound);
    await expectNothing(harness, CAPTURE.replies, 100);
    expect(await harness.runtime.store.get(KEYS.webhookDedup(wamid))).toBeNull();
  });
});

describe('dedup per message id (FR-WA-02)', () => {
  it('publishes and answers a redelivered message once', async () => {
    const body = messageNotification(newPhone(), { text: 'halo' });
    expect((await postWebhook(harness, body)).statusCode).toBe(200);
    expect((await postWebhook(harness, body)).statusCode).toBe(200);
    expect((await postWebhook(harness, body)).statusCode).toBe(200);
    expect(await take(harness, CAPTURE.inbound, 1)).toHaveLength(1);
    expect(await take(harness, CAPTURE.replies, 1)).toHaveLength(1);
    await expectNothing(harness, CAPTURE.inbound);
    await expectNothing(harness, CAPTURE.replies, 100);
  });

  it('the consumer ignores a duplicate that reached wa.inbound twice', async () => {
    const body = messageNotification(newPhone(), { text: 'halo' });
    expect((await postWebhook(harness, body)).statusCode).toBe(200);
    const [event] = await take(harness, CAPTURE.inbound, 1);
    await take(harness, CAPTURE.replies, 1);
    // A second copy (e.g. a publisher retry) goes straight into wa.inbound.
    harness.channel.sendToQueue(WA_INBOUND_QUEUE, Buffer.from(JSON.stringify(event)), {
      persistent: true,
    });
    await waitFor(
      () =>
        harness.runtime.metrics.total('antre_wa_inbound_duplicates_total', { stage: 'consumer' }) >
        0,
      5_000,
      'duplicate not detected',
    );
    await expectNothing(harness, CAPTURE.replies, 200);
  });
});

describe('delivery statuses', () => {
  it('publishes statuses[] as wa.status.received with tenant null', async () => {
    const response = await postWebhook(harness, {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA-IT',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1234567890' },
                statuses: [
                  {
                    id: 'wamid.OUT-IT-1',
                    status: 'read',
                    timestamp: '1792378800',
                    recipient_id: '6281234567890',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    const [event] = await take(harness, CAPTURE.statuses, 1);
    expect(event).toMatchObject({
      event_type: 'wa.status.received',
      tenant: null,
      data: { wamid: 'wamid.OUT-IT-1', status: 'READ', recipient: '6281234567890' },
    });
  });
});

describe('wa.inbound dead letters', () => {
  it('rejects a message that is not a valid event to wa.inbound.dlq', async () => {
    harness.channel.sendToQueue(WA_INBOUND_QUEUE, Buffer.from('{"not":"an event"}'));
    let dead: false | { properties: { headers?: Record<string, unknown> } } = false;
    await waitFor(
      async () => {
        dead = await harness.channel.get(WA_INBOUND_DLQ, { noAck: true });
        return dead !== false;
      },
      5_000,
      'message not dead-lettered',
    );
    expect(dead).not.toBe(false);
    expect(HEADERS.retry).toBe('x-antre-retry');
  });
});
