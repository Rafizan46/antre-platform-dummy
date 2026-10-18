import { randomUUID } from 'node:crypto';

import type { RealtimeUpdate } from '@antre/messaging/realtime';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeStore } from '../test/fake-store.js';
import { openSse, type SseConnection } from '../test/sse-client.js';
import { buildApp } from './app.js';
import { createTokenVerifier, extractToken } from './auth.js';
import { Broadcaster } from './broadcaster.js';
import { silentLogger } from './logger.js';
import { METRIC_NAMES, Metrics } from './metrics.js';

const SECRET = 'a-valid-secret-of-at-least-32-characters-long';
const TENANT_A = 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1';
const TENANT_B = '0f8f5a0e-6a43-4c55-9d0e-0d7a8b1c2e3f';
const LOCATION = '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90';
const OTHER_LOCATION = '7d1e2f3a-4b5c-4d6e-8f9a-0b1c2d3e4f5a';
const CHANNEL_A = `rt:${TENANT_A}:${LOCATION}`;
const LOG_A = `rt:log:${TENANT_A}:${LOCATION}`;

async function token(
  claims: Record<string, unknown>,
  options: { secret?: string; ttl?: number } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(randomUUID())
    .setIssuer('antre-auth')
    .setAudience('antre-api')
    .setIssuedAt(now)
    .setExpirationTime(now + (options.ttl ?? 3600))
    .sign(new TextEncoder().encode(options.secret ?? SECRET));
}

const staff = (tenantId = TENANT_A, role = 'OWNER') => token({ role, tenant_id: tenantId });
const kiosk = (locationId = LOCATION, issuedAtMs = Date.now()) =>
  token({
    role: 'KIOSK_DISPLAY',
    tenant_id: TENANT_A,
    location_id: locationId,
    iat_ms: issuedAtMs,
  });

function called(number: string): RealtimeUpdate {
  return {
    type: 'queue.ticket.called',
    event_id: `evt-${number}`,
    at: '2026-10-18T03:00:00Z',
    location_id: LOCATION,
    status: 'CALLED',
    ticket_number: number,
    resource_name: 'Loket 1',
    is_recall: false,
  };
}

let store: FakeStore;
let metrics: Metrics;
let app: ReturnType<typeof buildApp>;
let base: string;
const open: SseConnection[] = [];

async function connect(path: string, options: Parameters<typeof openSse>[1] = {}) {
  const connection = await openSse(`${base}${path}`, options);
  open.push(connection);
  return connection;
}
const streamPath = (locationId = LOCATION) => `/api/v1/realtime/locations/${locationId}/stream`;

beforeEach(async () => {
  store = new FakeStore();
  metrics = new Metrics();
  const broadcaster = new Broadcaster({
    store,
    metrics,
    log: silentLogger,
    maxConnections: 10,
    maxConnectionsPerTenant: 2,
  });
  app = buildApp({
    config: {
      retryMs: 1000,
      maxStreamSeconds: 60,
      maxBufferedBytes: 1_000_000,
      snapshotSize: 2,
      replayLimit: 3,
    },
    store,
    broadcaster,
    tokens: createTokenVerifier({ secret: SECRET, now: () => new Date() }),
    metrics,
    log: silentLogger,
    now: () => new Date(),
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  for (const connection of open.splice(0)) connection.close();
  await app.close();
});

describe('health endpoints', () => {
  it('reports health, readiness, and metrics', async () => {
    expect((await app.inject({ url: '/healthz' })).json()).toEqual({
      status: 'ok',
      service: 'realtime-gateway',
    });
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);
    store.ready = false;
    const notReady = await app.inject({ url: '/readyz' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toEqual({ status: 'unavailable', redis: false });
    const rendered = (await app.inject({ url: '/metrics' })).body;
    expect(rendered).toContain('# TYPE antre_rt_stream_requests_total counter');
  });
});

describe('stream authentication', () => {
  it('refuses missing, invalid, and expired tokens with 401', async () => {
    expect((await connect(streamPath())).status).toBe(401);
    expect((await connect(streamPath(), { token: 'nonsense' })).status).toBe(401);
    const forged = await token(
      { role: 'OWNER', tenant_id: TENANT_A },
      {
        secret: 'another-secret-of-at-least-32-characters',
      },
    );
    const refused = await connect(streamPath(), { token: forged });
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Autentikasi diperlukan atau token tidak valid.' },
    });
    const expired = await token({ role: 'OWNER', tenant_id: TENANT_A }, { ttl: -10 });
    expect((await connect(streamPath(), { token: expired })).status).toBe(401);
  });

  it('refuses SUPER_ADMIN and kiosk tokens of another location with 403', async () => {
    const admin = await token({ role: 'SUPER_ADMIN', tenant_id: null });
    expect((await connect(streamPath(), { token: admin })).status).toBe(403);
    expect((await connect(streamPath(OTHER_LOCATION), { token: await kiosk() })).status).toBe(403);
  });

  it('refuses revoked kiosk tokens and an invalid location id', async () => {
    store.revoked.set(`rt:kiosk-revoked:${TENANT_A}:${LOCATION}`, Date.now());
    expect(
      (await connect(streamPath(), { token: await kiosk(LOCATION, Date.now() - 1000) })).status,
    ).toBe(401);
    expect(
      (await connect('/api/v1/realtime/locations/x/stream', { token: await staff() })).status,
    ).toBe(404);
  });

  it('answers 503 while Redis is down and 429 above the tenant limit', async () => {
    store.ready = false;
    expect((await connect(streamPath(), { token: await staff() })).status).toBe(503);
    store.ready = true;
    await connect(streamPath(), { token: await staff() });
    await connect(streamPath(), { token: await staff(TENANT_A, 'STAFF_CALLER') });
    const limited = await connect(streamPath(), { token: await staff() });
    expect(limited.status).toBe(429);
    expect(metrics.total(METRIC_NAMES.streamRequests, { result: 'limited' })).toBe(1);
  });

  it('reads the token from ?access_token= or a bearer header', () => {
    expect(extractToken({ access_token: 'q' }, 'Bearer h')).toBe('q');
    expect(extractToken({}, 'Bearer h')).toBe('h');
    expect(extractToken({}, 'Basic x')).toBeNull();
  });
});

describe('stream delivery', () => {
  it('sends a snapshot, then live updates of the own tenant only', async () => {
    store.publish(LOG_A, CHANNEL_A, called('A-001'));
    const a = await connect(streamPath(), { token: await staff() });
    const kioskStream = await connect(streamPath(), { token: await kiosk(), header: true });
    const b = await connect(streamPath(), { token: await staff(TENANT_B) });
    expect(a.status).toBe(200);
    await a.waitFor((m) => m.event === 'snapshot');
    await kioskStream.waitFor((m) => m.event === 'snapshot');
    await b.waitFor((m) => m.event === 'snapshot');
    expect(a.messages[0]).toMatchObject({ event: 'snapshot', id: '1-0' });
    expect(b.messages[0]).toEqual({ event: 'snapshot', data: { updates: [] } });

    const id = store.publish(LOG_A, CHANNEL_A, called('A-002'));
    const received = await a.waitFor((m) => m.event === 'update');
    expect(received).toEqual({ event: 'update', id, data: called('A-002') });
    await kioskStream.waitFor((m) => m.event === 'update');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(b.messages.filter((m) => m.event === 'update')).toEqual([]);
  });

  it('replays after Last-Event-ID and falls back to a snapshot when too far behind', async () => {
    const first = store.publish(LOG_A, CHANNEL_A, called('A-001'));
    store.publish(LOG_A, CHANNEL_A, called('A-002'));
    store.publish(LOG_A, CHANNEL_A, called('A-003'));

    const resumed = await connect(streamPath(), { token: await staff(), lastEventId: first });
    await resumed.waitFor(
      (m) => m.data !== null && (m.data as RealtimeUpdate).ticket_number === 'A-003',
    );
    expect(resumed.messages.map((m) => m.event)).toEqual(['update', 'update']);

    for (const n of ['A-004', 'A-005']) store.publish(LOG_A, CHANNEL_A, called(n));
    const behind = await connect(streamPath(), { token: await staff(), lastEventId: first });
    const snapshot = await behind.waitFor((m) => m.event === 'snapshot');
    expect(
      (snapshot.data as { updates: RealtimeUpdate[] }).updates.map((u) => u.ticket_number),
    ).toEqual(['A-004', 'A-005']);
  });

  it('closes kiosk streams on revocation and every stream on shutdown', async () => {
    const a = await connect(streamPath(), { token: await staff() });
    await a.waitFor((m) => m.event === 'snapshot');
    const kioskStream = await connect(streamPath(), { token: await kiosk() });
    await kioskStream.waitFor((m) => m.event === 'snapshot');

    store.raw(CHANNEL_A, JSON.stringify({ control: 'kiosk_revoked', revoked_at: Date.now() }));
    await kioskStream.ended;
    expect(a.isEnded()).toBe(false);

    await app.close();
    await a.ended;
    expect(metrics.total(METRIC_NAMES.clientsClosed, { reason: 'shutdown' })).toBe(1);
  });
});

describe('hardening', () => {
  it('normalises an upper-case location id to the lower-case channel', async () => {
    const upper = await connect(streamPath(LOCATION.toUpperCase()), { token: await staff() });
    expect(upper.status).toBe(200);
    await upper.waitFor((m) => m.event === 'snapshot');
    const kioskUpper = await connect(streamPath(LOCATION.toUpperCase()), { token: await kiosk() });
    expect(kioskUpper.status).toBe(200);

    store.publish(LOG_A, CHANNEL_A, called('A-007'));
    await upper.waitFor((m) => m.event === 'update');
    await kioskUpper.waitFor((m) => m.event === 'update');
  });

  it('answers unknown routes without echoing the URL or the token', async () => {
    const response = await app.inject({
      url: '/api/v1/realtime/nope?access_token=secret-token-value',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Sumber daya tidak ditemukan.' },
    });
    expect(response.body).not.toContain('secret-token-value');
    expect(response.body).not.toContain('/api/v1');
  });

  it('limits slow request headers', () => {
    expect(app.server.headersTimeout).toBe(10_000);
    expect(app.server.requestTimeout).toBe(15_000);
  });
});
