// The closed list of SECURITY DEFINER functions (spec section 6.1), called by antre_app without
// a tenant context, exactly like login, WhatsApp resolution, delivery status updates, and jobs.
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

describe('SECURITY DEFINER functions', () => {
  let app: pg.Pool;
  let migrator: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    app = createPool('app');
    migrator = createPool('migrator', 2);
    tenantA = await createTenant(app);
    tenantB = await createTenant(app);
  });

  afterAll(async () => {
    await Promise.all([app.end(), migrator.end()]);
  });

  it('app_auth_find_user finds active users by case-insensitive email, including SUPER_ADMIN', async () => {
    const owner = await app.query(`SELECT * FROM app_auth_find_user($1)`, [
      tenantA.ownerEmail.toUpperCase(),
    ]);
    expect(owner.rows).toEqual([
      { id: expect.any(String), tenant_id: tenantA.tenantId, password_hash: 'hash', role: 'OWNER' },
    ]);

    const staffEmail = `staff-${tenantA.tenantId.slice(0, 8)}@example.test`;
    await inTransaction(app, tenantA.tenantId, (client) =>
      client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, is_active)
         VALUES ($1, $2, 'hash', 'STAFF_CALLER', false)`,
        [tenantA.tenantId, staffEmail],
      ),
    );
    const inactive = await app.query(`SELECT * FROM app_auth_find_user($1)`, [staffEmail]);
    expect(inactive.rowCount).toBe(0);

    const adminEmail = `admin-${tenantA.tenantId.slice(0, 8)}@antre.test`;
    await migrator.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES (NULL, $1, 'hash', 'SUPER_ADMIN')`,
      [adminEmail],
    );
    const superAdmin = await app.query(`SELECT tenant_id, role FROM app_auth_find_user($1)`, [
      adminEmail,
    ]);
    expect(superAdmin.rows).toEqual([{ tenant_id: null, role: 'SUPER_ADMIN' }]);
  });

  it('app_resolve_location resolves the WhatsApp keyword to an active location only', async () => {
    const resolved = await app.query(`SELECT * FROM app_resolve_location($1, $2)`, [
      tenantA.slug.toUpperCase(),
      'PUSAT',
    ]);
    expect(resolved.rows).toEqual([
      { tenant_id: tenantA.tenantId, location_id: tenantA.locationId },
    ]);

    await inTransaction(app, tenantA.tenantId, (client) =>
      client.query(
        `INSERT INTO locations (tenant_id, code, name, is_active) VALUES ($1, 'tutup', 'Tutup', false)`,
        [tenantA.tenantId],
      ),
    );
    const inactive = await app.query(`SELECT * FROM app_resolve_location($1, 'tutup')`, [
      tenantA.slug,
    ]);
    expect(inactive.rowCount).toBe(0);
  });

  it('app_find_active_by_phone returns active items of one number across tenants', async () => {
    const phone = '6281300000001';
    const ticketId = await inTransaction(app, tenantA.tenantId, async (client) => {
      await insertTicket(client, tenantA, {
        ticketNumber: 'A-101',
        customerPhone: phone,
        dayOffset: -1,
      });
      await insertTicket(client, tenantA, {
        ticketNumber: 'A-102',
        customerPhone: phone,
        status: 'COMPLETED',
      });
      return insertTicket(client, tenantA, { ticketNumber: 'A-103', customerPhone: phone });
    });
    const bookingId = await inTransaction(app, tenantB.tenantId, async (client) => {
      await insertBooking(client, tenantB, {
        customerPhone: phone,
        startTime: minutesFromNow(-120),
        status: 'CONFIRMED',
      });
      await insertBooking(client, tenantB, {
        customerPhone: phone,
        startTime: minutesFromNow(3 * 60),
        status: 'CANCELLED',
      });
      return insertBooking(client, tenantB, {
        customerPhone: phone,
        startTime: minutesFromNow(2 * 60),
        status: 'CONFIRMED',
      });
    });

    const { rows } = await app.query(`SELECT * FROM app_find_active_by_phone($1)`, [phone]);
    expect(rows).toEqual([
      {
        kind: 'TICKET',
        tenant_id: tenantA.tenantId,
        location_id: tenantA.locationId,
        item_id: ticketId,
      },
      {
        kind: 'BOOKING',
        tenant_id: tenantB.tenantId,
        location_id: tenantB.locationId,
        item_id: bookingId,
      },
    ]);
  });

  it('app_find_active_by_phone returns at most 10 rows', async () => {
    const phone = '6281300000002';
    await inTransaction(app, tenantB.tenantId, async (client) => {
      for (let hour = 10; hour < 21; hour += 1) {
        await insertBooking(client, tenantB, {
          customerPhone: phone,
          startTime: minutesFromNow(hour * 60),
          status: 'CONFIRMED',
        });
      }
    });
    const { rowCount } = await app.query(`SELECT * FROM app_find_active_by_phone($1)`, [phone]);
    expect(rowCount).toBe(10);
  });

  it('app_wa_update_delivery_status only moves the delivery status forward', async () => {
    const wamid = `wamid.${tenantA.tenantId}`;
    await inTransaction(app, tenantA.tenantId, (client) =>
      client.query(
        `INSERT INTO notification_logs (tenant_id, event_id, provider_message_id, recipient_phone, delivery_status)
         VALUES ($1, 'evt-status', $2, '6281300000003', 'SENT')`,
        [tenantA.tenantId, wamid],
      ),
    );
    const update = async (status: string): Promise<number> => {
      const { rows } = await app.query<{ updated: number }>(
        `SELECT app_wa_update_delivery_status($1, $2, $3) AS updated`,
        [wamid, status, '2026-10-17T10:00:00Z'],
      );
      return rows[0]?.updated ?? -1;
    };

    expect(await update('DELIVERED')).toBe(1);
    expect(await update('SENT')).toBe(0);
    expect(await update('READ')).toBe(1);
    expect(await update('FAILED')).toBe(0);
    const unknown = await app.query(
      `SELECT app_wa_update_delivery_status('wamid.unknown', 'SENT', now()) AS updated`,
    );
    expect(unknown.rows[0]).toEqual({ updated: 0 });
    await expect(update('sent')).rejects.toMatchObject({ code: '22023' });

    const stored = await inTransaction(app, tenantA.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT delivery_status, status_updated_at = $2::timestamptz AS stamped
         FROM notification_logs WHERE provider_message_id = $1`,
        [wamid, '2026-10-17T10:00:00Z'],
      );
      return rows[0];
    });
    expect(stored).toEqual({ delivery_status: 'READ', stamped: true });
  });

  it('app_due_booking_holds returns only PENDING_PAYMENT bookings past hold_expires_at', async () => {
    const [due, notDue] = await inTransaction(app, tenantA.tenantId, async (client) => [
      await insertBooking(client, tenantA, {
        customerPhone: '6281300000004',
        startTime: minutesFromNow(5 * 60),
        status: 'PENDING_PAYMENT',
        holdExpiresAt: minutesFromNow(-1),
      }),
      await insertBooking(client, tenantA, {
        customerPhone: '6281300000004',
        startTime: minutesFromNow(6 * 60),
        status: 'PENDING_PAYMENT',
        holdExpiresAt: minutesFromNow(5),
      }),
    ]);
    const { rows } = await app.query(`SELECT * FROM app_due_booking_holds()`);
    expect(rows).toContainEqual({ tenant_id: tenantA.tenantId, id: due });
    expect(rows).not.toContainEqual({ tenant_id: tenantA.tenantId, id: notDue });
  });

  it('app_due_booking_reminders returns CONFIRMED bookings starting within 30 minutes', async () => {
    const [due, later, reminded] = await inTransaction(app, tenantA.tenantId, async (client) => {
      const ids = [
        await insertBooking(client, tenantA, {
          customerPhone: '6281300000005',
          startTime: minutesFromNow(20),
          status: 'CONFIRMED',
        }),
        await insertBooking(client, tenantA, {
          customerPhone: '6281300000005',
          startTime: minutesFromNow(120),
          status: 'CONFIRMED',
        }),
        await insertBooking(client, tenantA, {
          customerPhone: '6281300000005',
          startTime: minutesFromNow(25),
          status: 'CONFIRMED',
        }),
      ];
      await client.query(`UPDATE bookings SET reminder_sent_at = now() WHERE id = $1`, [ids[2]]);
      return ids;
    });
    const { rows } = await app.query(`SELECT * FROM app_due_booking_reminders()`);
    expect(rows).toContainEqual({ tenant_id: tenantA.tenantId, id: due });
    expect(rows).not.toContainEqual({ tenant_id: tenantA.tenantId, id: later });
    expect(rows).not.toContainEqual({ tenant_id: tenantA.tenantId, id: reminded });
  });

  it('app_due_subscriptions returns expired checkouts and ended paid periods', async () => {
    const tenantC = await createTenant(app);
    const subscriptionId = async (fixture: TenantFixture, change: string): Promise<string> =>
      inTransaction(app, fixture.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `UPDATE subscriptions SET ${change} WHERE location_id = $1 RETURNING id`,
          [fixture.locationId],
        );
        return rows[0]?.id ?? '';
      });

    const expiredCheckout = await subscriptionId(
      tenantA,
      `status = 'PENDING_PAYMENT', pending_plan_code = 'PAID_LOCATION',
       payment_ref = 'pay-sub-' || gen_random_uuid(), pending_expires_at = now() - interval '1 minute'`,
    );
    const endedPeriod = await subscriptionId(
      tenantB,
      `plan_code = 'PAID_LOCATION', current_period_start = now() - interval '1 month',
       current_period_end = now() - interval '1 minute'`,
    );
    const activeFree = await subscriptionId(tenantC, `updated_at = now()`);

    const { rows } = await app.query(`SELECT * FROM app_due_subscriptions()`);
    expect(rows).toContainEqual({ tenant_id: tenantA.tenantId, id: expiredCheckout });
    expect(rows).toContainEqual({ tenant_id: tenantB.tenantId, id: endedPeriod });
    expect(rows).not.toContainEqual({ tenant_id: tenantC.tenantId, id: activeFree });
  });
});
