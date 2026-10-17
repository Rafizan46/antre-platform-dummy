// Key constraints: daily ticket numbering (K01), one active ticket per number, anti
// double-booking (FR-BOOKING-02, section 7.2), and the atomic FREE quota (section 7.3).
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPool,
  createTenant,
  inTransaction,
  insertBooking,
  insertTicket,
  minutesFromNow,
  type TenantFixture,
} from './helpers.js';

/** Next ticket sequence for (location, service, operating day), as the Queue Service will run it. */
const NEXT_SEQ_SQL = `
  INSERT INTO ticket_counters (tenant_id, location_id, service_id, service_date, last_seq)
  VALUES ($1, $2, $3, $4::date, 1)
  ON CONFLICT (location_id, service_id, service_date)
  DO UPDATE SET last_seq = ticket_counters.last_seq + 1
  RETURNING last_seq`;

/** Conditional quota increment from spec section 7.3. */
const QUOTA_INCREMENT_SQL = `
  UPDATE usage_counters AS uc
  SET ticket_count = uc.ticket_count + 1
  FROM subscriptions AS s
  JOIN plans AS p ON p.code = s.plan_code
  WHERE uc.location_id = $1
    AND uc.period_month = DATE '2026-10-01'
    AND s.location_id = uc.location_id
    AND (p.monthly_ticket_quota IS NULL OR uc.ticket_count < p.monthly_ticket_quota)
  RETURNING uc.ticket_count`;

function formatTicketNumber(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

describe('constraints', () => {
  let app: pg.Pool;
  let tenant: TenantFixture;

  beforeAll(async () => {
    app = createPool('app', 25);
    tenant = await createTenant(app);
  });

  afterAll(async () => {
    await app.end();
  });

  const nextSeq = (client: pg.PoolClient, serviceDate: string): Promise<number> =>
    client
      .query<{ last_seq: number }>(NEXT_SEQ_SQL, [
        tenant.tenantId,
        tenant.locationId,
        tenant.serviceId,
        serviceDate,
      ])
      .then((result) => result.rows[0]?.last_seq ?? -1);

  it('numbers tickets per location, service and operating day', async () => {
    const sequence = await inTransaction(app, tenant.tenantId, async (client) => [
      await nextSeq(client, '2026-01-05'),
      await nextSeq(client, '2026-01-05'),
      await nextSeq(client, '2026-01-05'),
      await nextSeq(client, '2026-01-06'),
    ]);
    expect(sequence).toEqual([1, 2, 3, 1]);
  });

  it('gives concurrent requests distinct consecutive numbers', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        inTransaction(app, tenant.tenantId, async (client) => {
          const seq = await nextSeq(client, '2026-01-07');
          const ticketNumber = formatTicketNumber('A', seq);
          await client.query(
            `INSERT INTO queue_tickets
               (tenant_id, location_id, service_id, service_date, ticket_number, channel, customer_name)
             VALUES ($1, $2, $3, DATE '2026-01-07', $4, 'STAFF', 'Pelanggan')`,
            [tenant.tenantId, tenant.locationId, tenant.serviceId, ticketNumber],
          );
          return seq;
        }),
      ),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('rejects a duplicate ticket number for the same location, service and day', async () => {
    await inTransaction(app, tenant.tenantId, (client) =>
      insertTicket(client, tenant, { ticketNumber: 'A-500', customerPhone: null }),
    );
    await expect(
      inTransaction(app, tenant.tenantId, (client) =>
        insertTicket(client, tenant, { ticketNumber: 'A-500', customerPhone: null }),
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'queue_tickets_ticket_number_key' });
  });

  it('keeps numbers of at least 3 digits and accepts more than 999 without truncation', async () => {
    expect(formatTicketNumber('B', 7)).toBe('B-007');
    expect(formatTicketNumber('B', 1000)).toBe('B-1000');
    await inTransaction(app, tenant.tenantId, (client) =>
      insertTicket(client, tenant, { ticketNumber: 'A-1000', customerPhone: null }),
    );
    await expect(
      inTransaction(app, tenant.tenantId, (client) =>
        insertTicket(client, tenant, { ticketNumber: 'A-01', customerPhone: null }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'queue_tickets_ticket_number_check' });
  });

  it('rejects phone numbers that are not canonical E.164 digits', async () => {
    await expect(
      inTransaction(app, tenant.tenantId, (client) =>
        insertTicket(client, tenant, { ticketNumber: 'A-501', customerPhone: '081234567890' }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'queue_tickets_customer_phone_check' });
  });

  it('allows one active ticket per phone per location per operating day', async () => {
    const phone = '6281400000001';
    await inTransaction(app, tenant.tenantId, async (client) => {
      await insertTicket(client, tenant, {
        ticketNumber: 'A-601',
        customerPhone: phone,
        dayOffset: -1,
      });
      await insertTicket(client, tenant, { ticketNumber: 'A-602', customerPhone: phone });
    });
    await expect(
      inTransaction(app, tenant.tenantId, (client) =>
        insertTicket(client, tenant, { ticketNumber: 'A-603', customerPhone: phone }),
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'queue_tickets_active_phone_key' });

    await inTransaction(app, tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE queue_tickets SET status = 'COMPLETED'
         WHERE ticket_number = 'A-602' AND location_id = $1`,
        [tenant.locationId],
      );
      await insertTicket(client, tenant, { ticketNumber: 'A-603', customerPhone: phone });
    });
  });

  it('lets the Queue Service expire tickets left active from an earlier operating day', async () => {
    const phone = '6281400000004';
    const [stale, current] = await inTransaction(app, tenant.tenantId, async (client) => [
      await insertTicket(client, tenant, {
        ticketNumber: 'A-701',
        customerPhone: phone,
        status: 'CALLED',
        dayOffset: -1,
      }),
      await insertTicket(client, tenant, { ticketNumber: 'A-702', customerPhone: phone }),
    ]);

    const statuses = await inTransaction(app, tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE queue_tickets AS t
         SET status = 'EXPIRED'
         FROM locations AS l
         WHERE l.id = t.location_id
           AND t.location_id = $1
           AND t.status IN ('WAITING', 'CALLED', 'SERVING')
           AND t.service_date < (now() AT TIME ZONE l.timezone)::date`,
        [tenant.locationId],
      );
      const { rows } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM queue_tickets WHERE id = ANY ($1)`,
        [[stale, current]],
      );
      return Object.fromEntries(rows.map((row) => [row.id, row.status]));
    });
    expect(statuses).toEqual({ [stale]: 'EXPIRED', [current]: 'WAITING' });
  });

  it('rejects a second active booking for the same resource and start time', async () => {
    const startTime = minutesFromNow(7 * 24 * 60);
    const first = await inTransaction(app, tenant.tenantId, (client) =>
      insertBooking(client, tenant, {
        customerPhone: '6281400000002',
        startTime,
        status: 'PENDING_PAYMENT',
      }),
    );
    await expect(
      inTransaction(app, tenant.tenantId, (client) =>
        insertBooking(client, tenant, {
          customerPhone: '6281400000003',
          startTime,
          status: 'CONFIRMED',
        }),
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'bookings_active_slot_key' });

    // Once the hold expires the slot is free again.
    await inTransaction(app, tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE bookings SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
        [first],
      );
      await insertBooking(client, tenant, {
        customerPhone: '6281400000003',
        startTime,
        status: 'CONFIRMED',
      });
    });
  });

  it('lets exactly one of many concurrent holds on one slot succeed', async () => {
    const startTime = minutesFromNow(8 * 24 * 60);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        inTransaction(app, tenant.tenantId, (client) =>
          insertBooking(client, tenant, {
            customerPhone: `62814000001${String(i).padStart(2, '0')}`,
            startTime,
            status: 'PENDING_PAYMENT',
          }),
        ),
      ),
    );
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({
        code: '23505',
        constraint: 'bookings_active_slot_key',
      });
    }
  });

  it('enforces the FREE quota atomically under concurrency (section 7.3)', async () => {
    await inTransaction(app, tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
         VALUES ($1, $2, DATE '2026-10-01', 95)`,
        [tenant.tenantId, tenant.locationId],
      ),
    );
    const counts = await Promise.all(
      Array.from({ length: 10 }, () =>
        inTransaction(app, tenant.tenantId, async (client) => {
          const { rows } = await client.query<{ ticket_count: number }>(QUOTA_INCREMENT_SQL, [
            tenant.locationId,
          ]);
          return rows[0]?.ticket_count ?? null;
        }),
      ),
    );
    const granted = counts.filter((count): count is number => count !== null);
    expect(granted.sort((a, b) => a - b)).toEqual([96, 97, 98, 99, 100]);
    expect(counts.filter((count) => count === null)).toHaveLength(5);
  });

  it('does not cap PAID_LOCATION locations', async () => {
    const paid = await createTenant(app);
    const count = await inTransaction(app, paid.tenantId, async (client) => {
      await client.query(
        `UPDATE subscriptions
         SET plan_code = 'PAID_LOCATION', current_period_start = now(),
             current_period_end = now() + interval '1 month'
         WHERE location_id = $1`,
        [paid.locationId],
      );
      await client.query(
        `INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
         VALUES ($1, $2, DATE '2026-10-01', 100)`,
        [paid.tenantId, paid.locationId],
      );
      const { rows } = await client.query<{ ticket_count: number }>(QUOTA_INCREMENT_SQL, [
        paid.locationId,
      ]);
      return rows[0]?.ticket_count;
    });
    expect(count).toBe(101);
  });
});
