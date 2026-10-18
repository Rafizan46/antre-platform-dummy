import { parseEvent } from '@antre/event-contracts';
import type {
  ActiveTicketResponse,
  CallNextResponse,
  QueueTicketDto,
  ServiceDto,
} from '@antre/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CLOCK_ISO,
  apiRequest,
  createClock,
  createTestApp,
  eventsOfType,
  internalHeaders,
  queryInTenant,
  setupQueueFixture,
  type QueueFixture,
  type TestApp,
} from './helpers.js';

const clock = createClock(DEFAULT_CLOCK_ISO);
let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp({ now: clock.now });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(() => {
  clock.set(DEFAULT_CLOCK_ISO);
  ctx.events.clear();
});

const MINUTE = 60_000;

type Headers = Record<string, string>;

function api(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  headers: Headers,
  payload?: object,
) {
  return apiRequest(ctx.app, method, url, headers, payload);
}

function sql<Row extends Record<string, unknown>>(
  f: QueueFixture,
  query: string,
  params: unknown[] = [],
) {
  return queryInTenant<Row>(ctx.pool, f.tenant.tenantId, query, params);
}

async function staffTicket(f: QueueFixture, body: object = {}, headers: Headers = f.owner) {
  return api('POST', '/api/v1/queues/tickets', headers, {
    location_id: f.locationId,
    service_id: f.serviceId,
    customer_name: 'Budi',
    ...body,
  });
}

async function staffTickets(f: QueueFixture, count: number): Promise<QueueTicketDto[]> {
  const tickets: QueueTicketDto[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await staffTicket(f);
    expect(response.statusCode).toBe(201);
    tickets.push(response.json<QueueTicketDto>());
  }
  return tickets;
}

function waTicket(f: QueueFixture, phone: string, body: object = {}) {
  return api('POST', '/internal/v1/queues/tickets', internalHeaders(ctx, f.tenant.tenantId), {
    location_id: f.locationId,
    service_id: f.serviceId,
    customer_phone: phone,
    ...body,
  });
}

function callNext(f: QueueFixture, headers: Headers = f.caller) {
  return api('POST', '/api/v1/queues/tickets/call-next', headers, {
    location_id: f.locationId,
    service_id: f.serviceId,
    resource_id: f.resourceId,
  });
}

function action(f: QueueFixture, ticketId: string, name: string, headers: Headers = f.caller) {
  return api('POST', `/api/v1/queues/tickets/${ticketId}/actions`, headers, { action: name });
}

async function listTickets(f: QueueFixture, query = ''): Promise<QueueTicketDto[]> {
  const response = await api(
    'GET',
    `/api/v1/queues/tickets?location_id=${f.locationId}${query}`,
    f.owner,
  );
  expect(response.statusCode).toBe(200);
  return response.json<{ tickets: QueueTicketDto[] }>().tickets;
}

async function updateSettings(f: QueueFixture, body: object) {
  const response = await api('PATCH', '/api/v1/tenants/me/settings', f.owner, body);
  expect(response.statusCode).toBe(200);
}

async function putHours(f: QueueFixture, days: object[]) {
  const response = await api(
    'PUT',
    `/api/v1/catalog/locations/${f.locationId}/operating-hours`,
    f.owner,
    { slot_interval_min: 30, days },
  );
  expect(response.statusCode).toBe(200);
}

async function setUsage(f: QueueFixture, count: number) {
  await sql(
    f,
    `INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
     VALUES ($1, $2, '2026-10-01', $3)
     ON CONFLICT (location_id, period_month) DO UPDATE SET ticket_count = $3`,
    [f.tenant.tenantId, f.locationId, count],
  );
}

async function usage(f: QueueFixture): Promise<number> {
  const rows = await sql<{ ticket_count: number }>(
    f,
    "SELECT ticket_count FROM usage_counters WHERE location_id = $1 AND period_month = '2026-10-01'",
    [f.locationId],
  );
  return rows[0]?.ticket_count ?? 0;
}

describe('ticket numbers', () => {
  it('numbers tickets per service and starts each service at 001', async () => {
    const f = await setupQueueFixture(ctx);
    const second = await api('POST', '/api/v1/catalog/services', f.owner, {
      name: 'Kasir',
      ticket_prefix: 'B',
      avg_duration_min: 5,
    });
    const serviceB = second.json<ServiceDto>().id;
    await api('POST', '/api/v1/catalog/resources', f.owner, {
      location_id: f.locationId,
      name: 'Loket 2',
      service_ids: [serviceB],
    });

    const tickets = await staffTickets(f, 3);
    expect(tickets.map((t) => t.ticket_number)).toEqual(['A-001', 'A-002', 'A-003']);
    expect(tickets[0]).toMatchObject({
      status: 'WAITING',
      channel: 'STAFF',
      service_name: 'Umum',
      service_date: '2026-10-19',
      customer_phone: null,
      resource_id: null,
      recall_count: 0,
    });

    const b = await staffTicket(f, { service_id: serviceB });
    expect(b.json<QueueTicketDto>().ticket_number).toBe('B-001');
  });

  it('resets the numbers on the next operating day and expires yesterday lazily', async () => {
    const f = await setupQueueFixture(ctx);
    const [first, second, third] = await staffTickets(f, 3);
    await callNext(f);
    await callNext(f);
    expect((await action(f, second!.id, 'SERVE')).statusCode).toBe(200);
    // first CALLED, second SERVING, third WAITING.

    clock.advance(24 * 60 * MINUTE);
    await f.refreshTokens();

    const today = await staffTicket(f);
    expect(today.json<QueueTicketDto>()).toMatchObject({
      ticket_number: 'A-001',
      service_date: '2026-10-20',
    });

    const rows = await sql<{ ticket_number: string; status: string; service_date: string }>(
      f,
      'SELECT ticket_number, status, service_date::text AS service_date FROM queue_tickets ORDER BY service_date, ticket_number',
    );
    expect(rows.map((r) => `${r.service_date} ${r.ticket_number} ${r.status}`)).toEqual([
      '2026-10-19 A-001 EXPIRED',
      '2026-10-19 A-002 EXPIRED',
      '2026-10-19 A-003 EXPIRED',
      '2026-10-20 A-001 WAITING',
    ]);

    const late = await action(f, first!.id, 'SERVE');
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('INVALID_TRANSITION');
    expect((await action(f, third!.id, 'NO_SHOW')).statusCode).toBe(409);
    expect(await listTickets(f)).toHaveLength(1);
  });

  it('uses the time zone of the location for the operating day', async () => {
    clock.set('2026-10-19T16:30:00Z');
    const jayapura = await setupQueueFixture(ctx);
    const jakarta = await setupQueueFixture(ctx);
    const patched = await api('PATCH', `/api/v1/locations/${jayapura.locationId}`, jayapura.owner, {
      timezone: 'Asia/Jayapura',
    });
    expect(patched.statusCode).toBe(200);

    expect((await staffTicket(jayapura)).json<QueueTicketDto>().service_date).toBe('2026-10-20');
    expect((await staffTicket(jakarta)).json<QueueTicketDto>().service_date).toBe('2026-10-19');
  });

  it('gives the same result whatever the time zone of the process', async () => {
    const original = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Asia/Jayapura', 'America/Los_Angeles']) {
        process.env.TZ = zone;
        // 23:30 on Monday in Jakarta, which is already Tuesday in Jayapura.
        clock.set('2026-10-19T16:30:00Z');
        const f = await setupQueueFixture(ctx);
        await putHours(f, [{ day_of_week: 1, open_time: '23:00', close_time: '23:59' }]);

        const open = await staffTicket(f);
        expect(open.statusCode).toBe(201);
        expect(open.json<QueueTicketDto>().service_date).toBe('2026-10-19');

        clock.set('2026-10-19T15:30:00Z'); // 22:30 in Jakarta: before opening
        const closed = await staffTicket(f);
        expect(closed.statusCode).toBe(409);
        expect(closed.json().error.code).toBe('LOCATION_CLOSED');
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('quota', () => {
  it('rejects the ticket at the quota with 402 and changes nothing', async () => {
    const f = await setupQueueFixture(ctx);
    await setUsage(f, 100);

    const response = await staffTicket(f);
    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(await usage(f)).toBe(100);
    expect(await sql(f, 'SELECT 1 FROM queue_tickets')).toHaveLength(0);
    expect(await sql(f, 'SELECT 1 FROM ticket_counters')).toHaveLength(0);
  });

  it('publishes the warning once at 80 and the exceeded event at 100', async () => {
    const f = await setupQueueFixture(ctx);
    await setUsage(f, 78);
    expect((await staffTicket(f)).statusCode).toBe(201); // 79
    expect(eventsOfType(ctx, 'billing.quota.warning')).toHaveLength(0);

    expect((await staffTicket(f)).statusCode).toBe(201); // 80
    expect((await staffTicket(f)).statusCode).toBe(201); // 81
    const warnings = eventsOfType(ctx, 'billing.quota.warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toMatchObject({
      plan_code: 'FREE',
      period_month: '2026-10-01',
      ticket_count: 80,
      monthly_ticket_quota: 100,
      admin_wa_phone: '6281234567890',
    });

    await setUsage(f, 98);
    expect((await staffTicket(f)).statusCode).toBe(201); // 99
    expect(eventsOfType(ctx, 'billing.quota.exceeded')).toHaveLength(0);
    expect((await staffTicket(f)).statusCode).toBe(201); // 100
    expect(eventsOfType(ctx, 'billing.quota.exceeded')).toHaveLength(1);
    expect((await staffTicket(f)).statusCode).toBe(402);
    expect(eventsOfType(ctx, 'billing.quota.exceeded')).toHaveLength(1);
  });

  it('does not limit a PAID_LOCATION subscription', async () => {
    const f = await setupQueueFixture(ctx);
    await sql(f, "UPDATE subscriptions SET plan_code = 'PAID_LOCATION' WHERE location_id = $1", [
      f.locationId,
    ]);
    await setUsage(f, 150);

    expect((await staffTicket(f)).statusCode).toBe(201);
    expect(await usage(f)).toBe(151);
    expect(eventsOfType(ctx, 'billing.quota.warning')).toHaveLength(0);
    expect(eventsOfType(ctx, 'billing.quota.exceeded')).toHaveLength(0);
  });
});

describe('transitions', () => {
  it('runs CALL_NEXT, SERVE, COMPLETE and publishes the events', async () => {
    const f = await setupQueueFixture(ctx);
    const [ticket] = await staffTickets(f, 1);

    const called = await callNext(f);
    expect(called.statusCode).toBe(200);
    expect(called.json<CallNextResponse>().ticket).toMatchObject({
      id: ticket!.id,
      status: 'CALLED',
      resource_id: f.resourceId,
      resource_name: 'Loket 1',
      people_ahead: null,
      estimated_serve_time: null,
    });

    clock.advance(5 * MINUTE);
    const served = await action(f, ticket!.id, 'SERVE');
    expect(served.json<QueueTicketDto>()).toMatchObject({
      status: 'SERVING',
      serving_at: '2026-10-19T03:05:00.000Z',
    });
    clock.advance(10 * MINUTE);
    const completed = await action(f, ticket!.id, 'COMPLETE');
    expect(completed.json<QueueTicketDto>()).toMatchObject({
      status: 'COMPLETED',
      completed_at: '2026-10-19T03:15:00.000Z',
    });

    expect(ctx.events.events.map((e) => e.event_type)).toEqual([
      'queue.ticket.created',
      'queue.ticket.called',
      'queue.ticket.serving',
      'queue.ticket.completed',
    ]);
    for (const event of ctx.events.events) expect(() => parseEvent(event)).not.toThrow();
  });

  it('recalls a called ticket and marks NO_SHOW', async () => {
    const f = await setupQueueFixture(ctx);
    const [ticket] = await staffTickets(f, 1);
    await callNext(f);

    const recalled = await action(f, ticket!.id, 'RECALL');
    expect(recalled.statusCode).toBe(200);
    expect(recalled.json<QueueTicketDto>()).toMatchObject({ status: 'CALLED', recall_count: 1 });
    const calledEvents = eventsOfType(ctx, 'queue.ticket.called');
    expect(calledEvents.map((e) => (e.data as { is_recall: boolean }).is_recall)).toEqual([
      false,
      true,
    ]);

    const noShow = await action(f, ticket!.id, 'NO_SHOW');
    expect(noShow.json<QueueTicketDto>().status).toBe('NO_SHOW');
    expect(eventsOfType(ctx, 'queue.ticket.no_show')).toHaveLength(1);
    expect((await action(f, ticket!.id, 'RECALL')).statusCode).toBe(409);
  });

  it('rejects illegal transitions with 409 and unknown actions with 400', async () => {
    const f = await setupQueueFixture(ctx);
    const [ticket] = await staffTickets(f, 2);

    const serveWaiting = await action(f, ticket!.id, 'SERVE');
    expect(serveWaiting.statusCode).toBe(409);
    expect(serveWaiting.json().error.code).toBe('INVALID_TRANSITION');
    expect((await action(f, ticket!.id, 'RECALL')).statusCode).toBe(409);

    await callNext(f);
    expect((await action(f, ticket!.id, 'COMPLETE')).statusCode).toBe(409);

    expect((await action(f, ticket!.id, 'CANCEL')).statusCode).toBe(400);
    expect((await action(f, ticket!.id, 'CALL_NEXT')).statusCode).toBe(400);
    expect((await action(f, '00000000-0000-4000-8000-000000000000', 'SERVE')).statusCode).toBe(404);

    // Cancel from CALLED through the WhatsApp endpoint.
    const wa = await waTicket(f, '6281300000001');
    const waTicketDto = wa.json<QueueTicketDto>();
    await callNext(f); // calls `other`
    await callNext(f); // calls the WhatsApp ticket
    const cancel = await api(
      'POST',
      `/internal/v1/queues/tickets/${waTicketDto.id}/cancel`,
      internalHeaders(ctx, f.tenant.tenantId),
      { customer_phone: '6281300000001' },
    );
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('applies the roles: cashiers cannot call, callers and cashiers can enter tickets', async () => {
    const f = await setupQueueFixture(ctx);
    expect((await staffTicket(f, {}, f.caller)).statusCode).toBe(201);
    const cashierTicket = await staffTicket(f, {}, f.cashier);
    expect(cashierTicket.statusCode).toBe(201);

    expect((await callNext(f, f.cashier)).statusCode).toBe(403);
    expect(
      (await action(f, cashierTicket.json<QueueTicketDto>().id, 'SERVE', f.cashier)).statusCode,
    ).toBe(403);
    expect((await callNext(f, f.owner)).statusCode).toBe(200);
    expect(
      (await api('GET', `/api/v1/queues/tickets?location_id=${f.locationId}`, f.cashier))
        .statusCode,
    ).toBe(200);
  });

  it('answers an empty queue with ticket null and checks the resource', async () => {
    const f = await setupQueueFixture(ctx);
    const empty = await callNext(f);
    expect(empty.statusCode).toBe(200);
    expect(empty.json<CallNextResponse>()).toEqual({ ticket: null });

    await staffTickets(f, 1);
    const unrelated = await api('POST', '/api/v1/catalog/resources', f.owner, {
      location_id: f.locationId,
      name: 'Tanpa layanan',
    });
    const wrongResource = await api('POST', '/api/v1/queues/tickets/call-next', f.caller, {
      location_id: f.locationId,
      service_id: f.serviceId,
      resource_id: unrelated.json<{ id: string }>().id,
    });
    expect(wrongResource.statusCode).toBe(404);

    await api('PATCH', `/api/v1/catalog/resources/${f.resourceId}`, f.owner, { is_active: false });
    expect((await callNext(f)).statusCode).toBe(404);
  });
});

describe('estimates and near turn', () => {
  it('estimates the wait from the people ahead and the average duration', async () => {
    const f = await setupQueueFixture(ctx);
    const created = await staffTickets(f, 3);
    expect(created.map((t) => t.people_ahead)).toEqual([0, 1, 2]);
    expect(created.map((t) => t.estimated_serve_time)).toEqual([
      '2026-10-19T03:00:00.000Z',
      '2026-10-19T03:10:00.000Z',
      '2026-10-19T03:20:00.000Z',
    ]);

    await callNext(f);
    const waiting = await listTickets(f, '&status=WAITING');
    expect(waiting.map((t) => [t.ticket_number, t.people_ahead, t.estimated_serve_time])).toEqual([
      ['A-002', 0, '2026-10-19T03:00:00.000Z'],
      ['A-003', 1, '2026-10-19T03:10:00.000Z'],
    ]);

    const all = await listTickets(f);
    expect(all.map((t) => [t.ticket_number, t.status, t.people_ahead])).toEqual([
      ['A-001', 'CALLED', null],
      ['A-002', 'WAITING', 0],
      ['A-003', 'WAITING', 1],
    ]);
  });

  it('hides only the estimate when show_wait_estimate is off', async () => {
    const f = await setupQueueFixture(ctx);
    await updateSettings(f, { show_wait_estimate: false });
    await staffTickets(f, 1);

    const wa = await waTicket(f, '6281300000002');
    expect(wa.statusCode).toBe(201);
    expect(wa.json<QueueTicketDto>()).toMatchObject({
      people_ahead: 1,
      estimated_serve_time: null,
      channel: 'WHATSAPP',
      customer_name: 'Pelanggan',
    });
    const created = eventsOfType(ctx, 'queue.ticket.created');
    expect(created[1]?.data).toMatchObject({ people_ahead: 1, estimated_serve_time: null });

    const active = await api(
      'GET',
      `/internal/v1/queues/tickets/active?location_id=${f.locationId}&customer_phone=6281300000002`,
      internalHeaders(ctx, f.tenant.tenantId),
    );
    expect(active.json<ActiveTicketResponse>().ticket).toMatchObject({
      people_ahead: 1,
      estimated_serve_time: null,
    });

    const staff = await listTickets(f);
    expect(staff.every((t) => t.estimated_serve_time !== null)).toBe(true);
  });

  it('publishes near_turn exactly once for a ticket that comes within two places', async () => {
    const f = await setupQueueFixture(ctx);
    const tickets = await staffTickets(f, 4);
    expect(eventsOfType(ctx, 'queue.ticket.near_turn')).toHaveLength(0);

    await callNext(f);
    const first = eventsOfType(ctx, 'queue.ticket.near_turn');
    expect(first).toHaveLength(1);
    expect(first[0]?.data).toMatchObject({
      ticket_id: tickets[3]!.id,
      ticket_number: 'A-004',
      people_ahead: 2,
    });

    await callNext(f);
    await callNext(f);
    expect(eventsOfType(ctx, 'queue.ticket.near_turn')).toHaveLength(1);
  });
});

describe('creating tickets', () => {
  it('allows one active ticket per phone and a new one after completion', async () => {
    const f = await setupQueueFixture(ctx);
    const first = await waTicket(f, '6281300000003');
    expect(first.statusCode).toBe(201);

    const again = await waTicket(f, '6281300000003');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ACTIVE_TICKET_EXISTS');
    expect(again.json().error.details.ticket).toMatchObject({ ticket_number: 'A-001' });
    const viaStaff = await staffTicket(f, { customer_phone: '6281300000003' });
    expect(viaStaff.statusCode).toBe(409);

    const called = await callNext(f);
    const id = called.json<CallNextResponse>().ticket!.id;
    await action(f, id, 'SERVE');
    await action(f, id, 'COMPLETE');

    const next = await waTicket(f, '6281300000003');
    expect(next.statusCode).toBe(201);
    expect(next.json<QueueTicketDto>().ticket_number).toBe('A-002');
  });

  it('refuses in reservation-only mode', async () => {
    const f = await setupQueueFixture(ctx);
    await updateSettings(f, { service_mode: 'RESERVATION' });

    for (const response of [await staffTicket(f), await waTicket(f, '6281300000004')]) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('MODE_DISABLED');
    }
    await updateSettings(f, { service_mode: 'WALK_IN' });
    expect((await staffTicket(f)).statusCode).toBe(201);
  });

  it('refuses when the location is closed', async () => {
    const f = await setupQueueFixture(ctx);
    const expectClosed = async () => {
      const response = await staffTicket(f);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('LOCATION_CLOSED');
    };

    await putHours(f, []); // no hours at all
    await expectClosed();

    await putHours(f, [{ day_of_week: 1, open_time: '11:00', close_time: '17:00' }]);
    await expectClosed(); // before opening (10:00 Monday)

    await putHours(f, [{ day_of_week: 2, open_time: '08:00', close_time: '17:00' }]);
    await expectClosed(); // another weekday

    await putHours(f, [
      {
        day_of_week: 1,
        open_time: '08:00',
        close_time: '17:00',
        break_start: '09:30',
        break_end: '10:30',
      },
    ]);
    await expectClosed(); // during the break
    clock.advance(30 * MINUTE); // 10:30, the break is over
    expect((await staffTicket(f)).statusCode).toBe(201);

    await putHours(f, [{ day_of_week: 1, open_time: '08:00', close_time: '10:30' }]);
    await expectClosed(); // closing time itself is closed

    await putHours(f, [{ day_of_week: 1, open_time: '08:00', close_time: '17:00' }]);
    await api('PATCH', `/api/v1/locations/${f.locationId}`, f.owner, { is_active: false });
    await expectClosed();
  });

  it('refuses a service that is inactive, unserved, or unknown', async () => {
    const f = await setupQueueFixture(ctx);
    const lonely = await api('POST', '/api/v1/catalog/services', f.owner, {
      name: 'Tanpa loket',
      ticket_prefix: 'C',
      avg_duration_min: 5,
    });
    expect((await staffTicket(f, { service_id: lonely.json<ServiceDto>().id })).statusCode).toBe(
      404,
    );
    expect(
      (await staffTicket(f, { service_id: '00000000-0000-4000-8000-000000000000' })).statusCode,
    ).toBe(404);

    await api('PATCH', `/api/v1/catalog/services/${f.serviceId}`, f.owner, { is_active: false });
    expect((await staffTicket(f)).statusCode).toBe(404);
    expect(
      (await staffTicket(f, { location_id: '00000000-0000-4000-8000-000000000000' })).statusCode,
    ).toBe(404);
  });

  it('rejects invalid bodies', async () => {
    const f = await setupQueueFixture(ctx);
    expect((await staffTicket(f, { customer_name: '  ' })).statusCode).toBe(400);
    expect((await staffTicket(f, { customer_phone: '0812' })).statusCode).toBe(400);
    expect((await staffTicket(f, { extra: true })).statusCode).toBe(400);
    expect((await waTicket(f, '0812')).statusCode).toBe(400);
  });
});

describe('internal API', () => {
  it('requires the service token, then the tenant header, then a known tenant', async () => {
    const f = await setupQueueFixture(ctx);
    const url = `/internal/v1/queues/tickets/active?location_id=${f.locationId}&customer_phone=6281300000005`;
    const tenant = f.tenant.tenantId;
    const good = internalHeaders(ctx, tenant);

    expect((await api('GET', url, {})).statusCode).toBe(401);
    expect((await api('GET', url, { 'x-antre-tenant-id': tenant })).statusCode).toBe(401);
    expect((await api('GET', url, { ...good, authorization: 'Bearer wrong' })).statusCode).toBe(
      401,
    );
    // A user JWT is not a service token.
    expect((await api('GET', url, { ...f.owner, 'x-antre-tenant-id': tenant })).statusCode).toBe(
      401,
    );

    const noTenant = await api('GET', url, { authorization: good.authorization! });
    expect(noTenant.statusCode).toBe(400);
    const badTenant = await api('GET', url, { ...good, 'x-antre-tenant-id': 'not-a-uuid' });
    expect(badTenant.statusCode).toBe(400);
    const unknown = await api('GET', url, {
      ...good,
      'x-antre-tenant-id': '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.statusCode).toBe(404);

    const ok = await api('GET', url, good);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<ActiveTicketResponse>()).toEqual({ ticket: null });

    // The service token does not work on the staff API.
    const staffApi = await api('GET', `/api/v1/queues/tickets?location_id=${f.locationId}`, {
      authorization: good.authorization!,
    });
    expect(staffApi.statusCode).toBe(401);
  });

  it('cancels a waiting ticket of the phone and hides tickets of other tenants', async () => {
    const f = await setupQueueFixture(ctx);
    const other = await setupQueueFixture(ctx);
    const headers = internalHeaders(ctx, f.tenant.tenantId);
    await staffTickets(f, 1);
    const wa = (await waTicket(f, '6281300000006')).json<QueueTicketDto>();
    const cancelUrl = `/internal/v1/queues/tickets/${wa.id}/cancel`;

    expect(
      (await api('POST', cancelUrl, headers, { customer_phone: '6281399999999' })).statusCode,
    ).toBe(404);
    const foreign = await api('POST', cancelUrl, internalHeaders(ctx, other.tenant.tenantId), {
      customer_phone: '6281300000006',
    });
    expect(foreign.statusCode).toBe(404);
    expect((await api('POST', cancelUrl, headers, {})).statusCode).toBe(400);

    const cancelled = await api('POST', cancelUrl, headers, { customer_phone: '6281300000006' });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<QueueTicketDto>()).toMatchObject({
      status: 'CANCELLED',
      people_ahead: null,
    });
    expect(eventsOfType(ctx, 'queue.ticket.cancelled')).toHaveLength(1);
    for (const event of ctx.events.events) expect(() => parseEvent(event)).not.toThrow();

    const again = await api('POST', cancelUrl, headers, { customer_phone: '6281300000006' });
    expect(again.statusCode).toBe(409);
    expect(
      (await api('POST', cancelUrl, headers, { customer_phone: '6281300000006' })).json().error
        .code,
    ).toBe('INVALID_TRANSITION');

    // The cancelled ticket frees the phone and is no longer active.
    const active = await api(
      'GET',
      `/internal/v1/queues/tickets/active?location_id=${f.locationId}&customer_phone=6281300000006`,
      headers,
    );
    expect(active.json<ActiveTicketResponse>().ticket).toBeNull();
    expect((await waTicket(f, '6281300000006')).statusCode).toBe(201);
  });

  it('reports the active ticket with its position', async () => {
    const f = await setupQueueFixture(ctx);
    const headers = internalHeaders(ctx, f.tenant.tenantId);
    await staffTickets(f, 2);
    await waTicket(f, '6281300000007');

    const active = await api(
      'GET',
      `/internal/v1/queues/tickets/active?location_id=${f.locationId}&customer_phone=6281300000007`,
      headers,
    );
    expect(active.json<ActiveTicketResponse>().ticket).toMatchObject({
      ticket_number: 'A-003',
      status: 'WAITING',
      people_ahead: 2,
      estimated_serve_time: '2026-10-19T03:20:00.000Z',
    });
  });

  it('lists the active services, limited to the location when given', async () => {
    const f = await setupQueueFixture(ctx);
    const headers = internalHeaders(ctx, f.tenant.tenantId);
    await api('POST', '/api/v1/catalog/services', f.owner, {
      name: 'Tanpa loket',
      ticket_prefix: 'C',
      avg_duration_min: 5,
    });
    await api('POST', '/api/v1/catalog/services', f.owner, {
      name: 'Nonaktif',
      ticket_prefix: 'D',
      avg_duration_min: 5,
      is_active: false,
    });

    const all = await api('GET', '/internal/v1/catalog/services', headers);
    expect(all.json<{ services: ServiceDto[] }>().services.map((s) => s.ticket_prefix)).toEqual([
      'C',
      'A',
    ]);
    const atLocation = await api(
      'GET',
      `/internal/v1/catalog/services?location_id=${f.locationId}`,
      headers,
    );
    expect(
      atLocation.json<{ services: ServiceDto[] }>().services.map((s) => s.ticket_prefix),
    ).toEqual(['A']);
  });
});

describe('event contract', () => {
  it('publishes every queue.* event type in a valid envelope', async () => {
    const f = await setupQueueFixture(ctx);
    const headers = internalHeaders(ctx, f.tenant.tenantId);
    const tickets = await staffTickets(f, 5);
    const wa = (await waTicket(f, '6281300000008')).json<QueueTicketDto>();
    await callNext(f); // 1 called
    await action(f, tickets[0]!.id, 'SERVE');
    await action(f, tickets[0]!.id, 'COMPLETE');
    await callNext(f); // 2 called
    await action(f, tickets[1]!.id, 'NO_SHOW');
    await api('POST', `/internal/v1/queues/tickets/${wa.id}/cancel`, headers, {
      customer_phone: '6281300000008',
    });

    const types = new Set(ctx.events.events.map((event) => event.event_type));
    expect([...types].sort()).toEqual([
      'queue.ticket.called',
      'queue.ticket.cancelled',
      'queue.ticket.completed',
      'queue.ticket.created',
      'queue.ticket.near_turn',
      'queue.ticket.no_show',
      'queue.ticket.serving',
    ]);
    for (const event of ctx.events.events) {
      const parsed = parseEvent(event);
      expect(parsed.tenant).toMatchObject({ id: f.tenant.tenantId });
      expect(parsed.location).toMatchObject({ id: f.locationId, code: 'pusat' });
    }
  });
});
