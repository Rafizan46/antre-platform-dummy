import type { CallNextResponse, QueueTicketDto } from '@antre/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiRequest,
  createClock,
  createTestApp,
  DEFAULT_CLOCK_ISO,
  eventsOfType,
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

function createTicket(f: QueueFixture, name: string) {
  return apiRequest(ctx.app, 'POST', '/api/v1/queues/tickets', f.owner, {
    location_id: f.locationId,
    service_id: f.serviceId,
    customer_name: name,
  });
}

function callNext(f: QueueFixture) {
  return apiRequest(ctx.app, 'POST', '/api/v1/queues/tickets/call-next', f.caller, {
    location_id: f.locationId,
    service_id: f.serviceId,
    resource_id: f.resourceId,
  });
}

describe('concurrency', () => {
  it('calls every waiting ticket exactly once under 20 parallel CALL_NEXT', async () => {
    const f = await setupQueueFixture(ctx);
    for (let index = 0; index < 15; index += 1) {
      expect((await createTicket(f, `Pelanggan ${index}`)).statusCode).toBe(201);
    }
    ctx.events.clear();

    const responses = await Promise.all(Array.from({ length: 20 }, () => callNext(f)));
    expect(responses.map((r) => r.statusCode)).toEqual(Array(20).fill(200));
    const tickets = responses.map((r) => r.json<CallNextResponse>().ticket);
    const called = tickets.filter((ticket) => ticket !== null);
    expect(called).toHaveLength(15);
    expect(new Set(called.map((ticket) => ticket.id)).size).toBe(15);
    expect(tickets.filter((ticket) => ticket === null)).toHaveLength(5);

    const counts = await queryInTenant<{ status: string; total: number }>(
      ctx.pool,
      f.tenant.tenantId,
      'SELECT status, count(*)::int AS total FROM queue_tickets GROUP BY status',
    );
    expect(counts).toEqual([{ status: 'CALLED', total: 15 }]);
    expect(eventsOfType(ctx, 'queue.ticket.called')).toHaveLength(15);
  });

  it('numbers 20 parallel creations A-001..A-020 without gaps or duplicates', async () => {
    const f = await setupQueueFixture(ctx);
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => createTicket(f, `Pelanggan ${index}`)),
    );
    expect(responses.map((r) => r.statusCode)).toEqual(Array(20).fill(201));

    const numbers = responses.map((r) => r.json<QueueTicketDto>().ticket_number).sort();
    const expected = Array.from(
      { length: 20 },
      (_, index) => `A-${String(index + 1).padStart(3, '0')}`,
    );
    expect(numbers).toEqual(expected);
  });

  it('admits exactly the remaining quota under parallel creations', async () => {
    const f = await setupQueueFixture(ctx);
    await queryInTenant(
      ctx.pool,
      f.tenant.tenantId,
      `INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
       VALUES ($1, $2, '2026-10-01', 95)`,
      [f.tenant.tenantId, f.locationId],
    );

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => createTicket(f, `Pelanggan ${index}`)),
    );
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((status) => status === 201)).toHaveLength(5);
    expect(statuses.filter((status) => status === 402)).toHaveLength(5);

    const usage = await queryInTenant<{ ticket_count: number }>(
      ctx.pool,
      f.tenant.tenantId,
      'SELECT ticket_count FROM usage_counters WHERE location_id = $1',
      [f.locationId],
    );
    expect(usage[0]?.ticket_count).toBe(100);
    const tickets = await queryInTenant(ctx.pool, f.tenant.tenantId, 'SELECT 1 FROM queue_tickets');
    expect(tickets).toHaveLength(5);
  });
});
