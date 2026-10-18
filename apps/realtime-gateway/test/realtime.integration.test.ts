// S10 end to end: core services (real PostgreSQL + Redis) -> Redis update log + Pub/Sub ->
// Realtime SSE Gateway -> SSE clients (FR-REALTIME-01/02).
import type { RealtimeUpdate } from '@antre/messaging/realtime';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  bearerToken,
  createHarness,
  issueKioskToken,
  streamUrl,
  ticketAndCall,
  waitFor,
  type Harness,
} from './helpers.js';
import { openSse, type SseConnection, type SseMessage } from './sse-client.js';

let h: Harness;
const open: SseConnection[] = [];

beforeAll(async () => {
  h = await createHarness();
});

afterEach(() => {
  for (const connection of open.splice(0)) connection.close();
});

afterAll(async () => {
  await h?.close();
});

async function connect(locationId: string, options: Parameters<typeof openSse>[1]) {
  const connection = await openSse(streamUrl(h, locationId), options);
  open.push(connection);
  return connection;
}

const isCalled = (number: string) => (m: SseMessage) =>
  m.event === 'update' &&
  (m.data as RealtimeUpdate).type === 'queue.ticket.called' &&
  (m.data as RealtimeUpdate).ticket_number === number;

async function ready(connection: SseConnection): Promise<SseConnection> {
  expect(connection.status).toBe(200);
  await connection.waitFor((m) => m.event === 'snapshot' || m.event === 'update');
  return connection;
}

describe('CALL_NEXT reaches the SSE streams of the same tenant only', () => {
  it('delivers queue.ticket.called without customer data', async () => {
    const a = await ready(
      await connect(h.tenantA.locationId, { token: bearerToken(h.tenantA.owner) }),
    );
    const b = await ready(
      await connect(h.tenantB.locationId, { token: bearerToken(h.tenantB.owner) }),
    );
    // Tenant B asking for tenant A's location gets an empty stream (channel of its own tenant).
    const probe = await ready(
      await connect(h.tenantA.locationId, { token: bearerToken(h.tenantB.owner) }),
    );

    const ticket = await ticketAndCall(h.core, h.tenantA);

    const message = await a.waitFor(isCalled(ticket.ticket_number));
    expect(message.id).toMatch(/^[0-9]+-[0-9]+$/);
    expect(message.data).toMatchObject({
      type: 'queue.ticket.called',
      status: 'CALLED',
      location_id: h.tenantA.locationId,
      resource_name: 'Ruang A',
      is_recall: false,
    });
    const created = await a.waitFor(
      (m) => m.event === 'update' && (m.data as RealtimeUpdate).type === 'queue.ticket.created',
    );
    for (const m of [message, created]) {
      const json = JSON.stringify(m.data);
      expect(json).not.toMatch(/62812[0-9]{8}/);
      expect(json).not.toContain('Budi');
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(b.messages.filter((m) => m.event === 'update')).toEqual([]);
    expect(probe.messages.filter((m) => m.event === 'update')).toEqual([]);
  });

  it('replays missed updates after Last-Event-ID', async () => {
    const first = await ready(
      await connect(h.tenantA.locationId, { token: bearerToken(h.tenantA.owner) }),
    );
    const ticket = await ticketAndCall(h.core, h.tenantA);
    const seen = await first.waitFor(isCalled(ticket.ticket_number));
    first.close();

    const missed = await ticketAndCall(h.core, h.tenantA);
    const resumed = await connect(h.tenantA.locationId, {
      token: bearerToken(h.tenantA.owner),
      lastEventId: seen.id!,
    });

    await resumed.waitFor(isCalled(missed.ticket_number));
    expect(resumed.messages.some((m) => m.event === 'snapshot')).toBe(false);
    expect(resumed.messages.some(isCalled(ticket.ticket_number))).toBe(false);
  });
});

describe('authentication', () => {
  it('refuses a wrong token with 401', async () => {
    const forged = `${bearerToken(h.tenantA.owner).slice(0, -4)}AAAA`;
    expect((await connect(h.tenantA.locationId, { token: forged })).status).toBe(401);
    expect((await connect(h.tenantA.locationId, {})).status).toBe(401);
  });

  it('serves a KIOSK_DISPLAY token for its location until the owner revokes it', async () => {
    const token = await issueKioskToken(h.core, h.tenantA);
    expect((await connect(h.tenantB.locationId, { token })).status).toBe(403);
    const kiosk = await ready(await connect(h.tenantA.locationId, { token }));

    const ticket = await ticketAndCall(h.core, h.tenantA);
    await kiosk.waitFor(isCalled(ticket.ticket_number));

    const revoked = await h.core.app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${h.tenantA.locationId}/kiosk-tokens`,
      headers: h.tenantA.owner,
    });
    expect(revoked.statusCode).toBe(204);
    await kiosk.ended;
    expect((await connect(h.tenantA.locationId, { token })).status).toBe(401);

    // A token issued after the revocation works again.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fresh = await issueKioskToken(h.core, h.tenantA);
    await ready(await connect(h.tenantA.locationId, { token: fresh }));
  });
});

describe('Redis outage', () => {
  it('answers /readyz 503, closes the streams, and lets clients reconnect and catch up', async () => {
    const token = bearerToken(h.tenantA.owner);
    const before = await ready(await connect(h.tenantA.locationId, { token }));
    const ticket = await ticketAndCall(h.core, h.tenantA);
    const seen = await before.waitFor(isCalled(ticket.ticket_number));

    await h.proxy.stop();
    await waitFor(
      async () => (await fetch(`${h.url}/readyz`)).status === 503,
      10_000,
      '/readyz stayed 200',
    );
    await before.ended;
    expect((await connect(h.tenantA.locationId, { token })).status).toBe(503);

    // The core services still reach Redis; the update lands in the log meanwhile.
    const missed = await ticketAndCall(h.core, h.tenantA);

    await h.proxy.start();
    await waitFor(
      async () => (await fetch(`${h.url}/readyz`)).status === 200,
      15_000,
      '/readyz stayed 503',
    );
    const resumed = await connect(h.tenantA.locationId, { token, lastEventId: seen.id! });
    await resumed.waitFor(isCalled(missed.ticket_number));

    const live = await ticketAndCall(h.core, h.tenantA);
    await resumed.waitFor(isCalled(live.ticket_number));
    expect(await (await fetch(`${h.url}/metrics`)).text()).toContain(
      'antre_rt_clients_closed_total{reason="redis_unavailable"}',
    );
  });
});
