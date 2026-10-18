import { describe, expect, it } from 'vitest';

import { buildApp, WEBHOOK_PREFIX } from './app.js';
import { silentLogger } from './logger.js';
import { METRIC_NAMES, Metrics } from './metrics.js';
import { InMemoryStore, KEYS } from './store.js';
import { RecordingSink } from './testing.js';
import { WEBHOOK_BODY_LIMIT } from './webhook/routes.js';
import { signPayload } from './webhook/signature.js';

const APP_SECRET = 'test-app-secret-0123456789';
const VERIFY_TOKEN = 'test-verify-token-0123';
const URL = `${WEBHOOK_PREFIX}/webhook`;

function setup(options: { phoneNumberId?: string | null } = {}) {
  const events = new RecordingSink();
  const store = new InMemoryStore();
  const metrics = new Metrics();
  const checks = { broker: true, consumer: true, redis: true };
  const app = buildApp({
    metrics,
    readiness: { checks: () => checks },
    webhook: {
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      phoneNumberId: options.phoneNumberId ?? null,
      events,
      store,
      log: silentLogger,
      metrics,
    },
  });
  return { app, events, store, metrics, checks };
}

function notification(
  value: Record<string, unknown>,
  phoneNumberId = '1234567890',
): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '628100000000', phone_number_id: phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

function textMessage(id: string, body: string, from = '6281234567890') {
  return {
    contacts: [{ wa_id: from, profile: { name: 'Budi Santoso' } }],
    messages: [{ from, id, timestamp: '1792378800', type: 'text', text: { body } }],
  };
}

function post(app: ReturnType<typeof buildApp>, body: object | string, signature?: string) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: URL,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature ?? signPayload(raw, APP_SECRET),
    },
    payload: raw,
  });
}

describe('health endpoints', () => {
  it('GET /healthz responds with status ok', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'wa-channel' });
  });

  it('GET /readyz is 503 while a dependency is not ready', async () => {
    const { app, checks } = setup();
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    checks.consumer = false;
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not ready',
      checks: { broker: true, consumer: false, redis: true },
    });
  });

  it('GET /metrics renders Prometheus text', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# TYPE antre_wa_webhook_requests_total counter');
  });
});

describe('GET webhook verification (FR-WA-02)', () => {
  it('returns hub.challenge for the right verify token', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'GET',
      url: `${URL}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('1158201444');
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('refuses a wrong token, a wrong mode, or a missing challenge with 403', async () => {
    const { app } = setup();
    for (const query of [
      `hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`,
      `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
      `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`,
      `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=%3Cscript%3E`,
    ]) {
      const response = await app.inject({ method: 'GET', url: `${URL}?${query}` });
      expect(response.statusCode).toBe(403);
    }
  });
});

describe('POST webhook (FR-WA-02)', () => {
  it('publishes a verified message as wa.message.received with tenant null and answers 200', async () => {
    const { app, events, metrics } = setup();
    const response = await post(app, notification(textMessage('wamid.A1', 'ANTRE klinik pusat')));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    const [event] = events.ofType('wa.message.received');
    expect(event).toMatchObject({
      tenant: null,
      location: null,
      data: {
        wamid: 'wamid.A1',
        from: '6281234567890',
        profile_name: 'Budi Santoso',
        type: 'text',
        text: 'ANTRE klinik pusat',
        reply_id: null,
      },
    });
    expect(metrics.total(METRIC_NAMES.inboundPublished)).toBe(1);
  });

  it('rejects a missing or wrong X-Hub-Signature-256 with 401 and publishes nothing', async () => {
    const { app, events, store } = setup();
    const body = JSON.stringify(notification(textMessage('wamid.B1', 'halo')));
    const wrongSecret = await post(app, body, signPayload(body, 'another-secret-0000000'));
    expect(wrongSecret.statusCode).toBe(401);
    const tampered = await post(app, body.replace('halo', 'hola'), signPayload(body, APP_SECRET));
    expect(tampered.statusCode).toBe(401);
    const missing = await app.inject({
      method: 'POST',
      url: URL,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(missing.statusCode).toBe(401);
    expect(events.events).toHaveLength(0);
    expect(store.keys()).toEqual([]);
  });

  it('drops a duplicate wamid (SET wa:msg:{wamid} NX EX 86400)', async () => {
    const { app, events, store, metrics } = setup();
    const body = notification(textMessage('wamid.C1', 'halo'));
    expect((await post(app, body)).statusCode).toBe(200);
    expect((await post(app, body)).statusCode).toBe(200);
    expect(events.ofType('wa.message.received')).toHaveLength(1);
    expect(store.ttl(KEYS.webhookDedup('wamid.C1'))).toBeGreaterThan(24 * 60 * 60 * 1000 - 1000);
    expect(metrics.total(METRIC_NAMES.inboundDuplicates, { stage: 'webhook' })).toBe(1);
  });

  it('answers 503 without a dedup key while the broker is down, so Meta retries', async () => {
    const { app, events, store } = setup();
    events.connected = false;
    const body = notification(textMessage('wamid.D1', 'halo'));
    expect((await post(app, body)).statusCode).toBe(503);
    expect(store.keys()).toEqual([]);
    events.connected = true;
    expect((await post(app, body)).statusCode).toBe(200);
    expect(events.ofType('wa.message.received')).toHaveLength(1);
  });

  it('still publishes when Redis is down (the consumer deduplicates again)', async () => {
    const { app, events, store } = setup();
    store.failing = true;
    expect((await post(app, notification(textMessage('wamid.E1', 'halo')))).statusCode).toBe(200);
    expect(events.ofType('wa.message.received')).toHaveLength(1);
  });

  it('publishes delivery statuses as wa.status.received', async () => {
    const { app, events } = setup();
    const response = await post(
      app,
      notification({
        statuses: [
          {
            id: 'wamid.OUT1',
            status: 'delivered',
            timestamp: '1792378800',
            recipient_id: '6281234567890',
          },
          {
            id: 'wamid.OUT2',
            status: 'read',
            timestamp: '1792378860',
            recipient_id: '6281234567890',
          },
          {
            id: 'wamid.OUT3',
            status: 'deleted',
            timestamp: '1792378860',
            recipient_id: '6281234567890',
          },
        ],
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(events.ofType('wa.status.received').map((event) => event.data)).toEqual([
      {
        wamid: 'wamid.OUT1',
        status: 'DELIVERED',
        status_at: '2026-10-19T03:00:00.000Z',
        recipient: '6281234567890',
      },
      {
        wamid: 'wamid.OUT2',
        status: 'READ',
        status_at: '2026-10-19T03:01:00.000Z',
        recipient: '6281234567890',
      },
    ]);
  });

  it('ignores changes for another phone number id when one is configured', async () => {
    const { app, events } = setup({ phoneNumberId: '1234567890' });
    await post(app, notification(textMessage('wamid.F1', 'halo'), '999'));
    expect(events.events).toHaveLength(0);
    await post(app, notification(textMessage('wamid.F2', 'halo'), '1234567890'));
    expect(events.events).toHaveLength(1);
  });

  it('answers 400 for invalid JSON, 200 for other objects, 415 and 413 for wrong bodies', async () => {
    const { app, events } = setup();
    expect((await post(app, '{not json')).statusCode).toBe(400);
    expect((await post(app, { object: 'page', entry: [] })).statusCode).toBe(200);
    const wrongType = await app.inject({
      method: 'POST',
      url: URL,
      headers: { 'content-type': 'text/plain' },
      payload: 'halo',
    });
    expect(wrongType.statusCode).toBe(415);
    const huge = JSON.stringify({ object: 'x', padding: 'x'.repeat(WEBHOOK_BODY_LIMIT) });
    expect((await post(app, huge)).statusCode).toBe(413);
    expect(events.events).toHaveLength(0);
  });
});
