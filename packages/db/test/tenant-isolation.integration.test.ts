// RLS isolation (NFR-SECU-01, spec section 6.1): tenant A never sees or changes tenant B rows,
// no tenant context means 0 rows, cross-tenant references are rejected, and the non-runtime
// roles only get what section 6.1 grants them.
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

/** Tenant-dependent tables and the column holding their tenant id. */
const TENANT_TABLES: ReadonlyArray<readonly [table: string, tenantColumn: string]> = [
  ['tenants', 'id'],
  ['users', 'tenant_id'],
  ['locations', 'tenant_id'],
  ['operating_hours', 'tenant_id'],
  ['resources', 'tenant_id'],
  ['services', 'tenant_id'],
  ['service_resources', 'tenant_id'],
  ['ticket_counters', 'tenant_id'],
  ['queue_tickets', 'tenant_id'],
  ['bookings', 'tenant_id'],
  ['notification_logs', 'tenant_id'],
  ['subscriptions', 'tenant_id'],
  ['usage_counters', 'tenant_id'],
];

/** Adds one row to every tenant table not filled by createTenant. */
async function addOperationalRows(
  app: pg.Pool,
  fixture: TenantFixture,
  phone: string,
): Promise<void> {
  await inTransaction(app, fixture.tenantId, async (client) => {
    await client.query(
      `INSERT INTO operating_hours (tenant_id, location_id, day_of_week, open_time, close_time)
       VALUES ($1, $2, 1, '08:00', '17:00')`,
      [fixture.tenantId, fixture.locationId],
    );
    await client.query(
      `INSERT INTO ticket_counters (tenant_id, location_id, service_id, service_date, last_seq)
       VALUES ($1, $2, $3, DATE '2026-10-17', 1)`,
      [fixture.tenantId, fixture.locationId, fixture.serviceId],
    );
    await insertTicket(client, fixture, { ticketNumber: 'A-001', customerPhone: phone });
    await insertBooking(client, fixture, {
      customerPhone: phone,
      startTime: minutesFromNow(24 * 60),
      status: 'CONFIRMED',
    });
    await client.query(
      `INSERT INTO notification_logs (tenant_id, event_id, recipient_phone)
       VALUES ($1, 'evt-isolation', $2)`,
      [fixture.tenantId, phone],
    );
    await client.query(
      `INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
       VALUES ($1, $2, DATE '2026-10-01', 1)`,
      [fixture.tenantId, fixture.locationId],
    );
  });
}

describe('tenant isolation', () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let migrator: pg.Pool;
  let platformAdmin: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    admin = createPool('admin', 2);
    app = createPool('app');
    migrator = createPool('migrator', 2);
    platformAdmin = createPool('platformAdmin', 2);
    tenantA = await createTenant(app);
    tenantB = await createTenant(app);
    await addOperationalRows(app, tenantA, '6281200000001');
    await addOperationalRows(app, tenantB, '6281200000002');
  });

  afterAll(async () => {
    await Promise.all([admin.end(), app.end(), migrator.end(), platformAdmin.end()]);
  });

  it.each(TENANT_TABLES)('%s: tenant A context sees only tenant A rows', async (table, column) => {
    const counts = await inTransaction(app, tenantA.tenantId, async (client) => {
      const { rows } = await client.query<{ total: number; own: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${column} = $1)::int AS own
         FROM ${table}`,
        [tenantA.tenantId],
      );
      return rows[0];
    });
    expect(counts?.total).toBeGreaterThan(0);
    expect(counts?.own).toBe(counts?.total);
  });

  it.each(TENANT_TABLES)('%s: no tenant context (unset or empty) returns 0 rows', async (table) => {
    for (const setting of [null, '']) {
      const total = await inTransaction(app, setting, async (client) => {
        const { rows } = await client.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM ${table}`,
        );
        return rows[0]?.total;
      });
      expect(total).toBe(0);
    }
  });

  it('rejects inserting a row for another tenant or without tenant context', async () => {
    await expect(
      inTransaction(app, tenantA.tenantId, (client) =>
        client.query(`INSERT INTO locations (tenant_id, code, name) VALUES ($1, 'evil', 'Evil')`, [
          tenantB.tenantId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      inTransaction(app, null, (client) =>
        client.query(
          `INSERT INTO tenants (name, slug, business_type, admin_wa_phone)
           VALUES ('No context', 'no-context', 'OTHER', '6281100000000')`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot update or delete tenant B rows from tenant A context', async () => {
    const affected = await inTransaction(app, tenantA.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE locations SET name = 'Hacked' WHERE tenant_id = $1`,
        [tenantB.tenantId],
      );
      const deleted = await client.query(`DELETE FROM notification_logs WHERE tenant_id = $1`, [
        tenantB.tenantId,
      ]);
      return [updated.rowCount, deleted.rowCount];
    });
    expect(affected).toEqual([0, 0]);

    const name = await inTransaction(app, tenantB.tenantId, async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `SELECT name FROM locations WHERE id = $1`,
        [tenantB.locationId],
      );
      return rows[0]?.name;
    });
    expect(name).toBe('Pusat');
  });

  it('rejects references to another tenant through the composite foreign keys', async () => {
    await expect(
      inTransaction(app, tenantA.tenantId, (client) =>
        insertTicket(
          client,
          { ...tenantA, serviceId: tenantB.serviceId },
          {
            ticketNumber: 'A-900',
            customerPhone: null,
          },
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      inTransaction(app, tenantA.tenantId, (client) =>
        insertBooking(
          client,
          { ...tenantA, resourceId: tenantB.resourceId },
          {
            customerPhone: '6281200000009',
            startTime: minutesFromNow(48 * 60),
            status: 'CONFIRMED',
          },
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('gives antre_platform_admin read-only access to the console tables only', async () => {
    const tenants = await platformAdmin.query<{ slug: string }>(`SELECT slug FROM tenants`);
    expect(tenants.rows.map((row) => row.slug)).toEqual(
      expect.arrayContaining([tenantA.slug, tenantB.slug]),
    );
    const usage = await platformAdmin.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM usage_counters WHERE tenant_id = ANY ($1)`,
      [[tenantA.tenantId, tenantB.tenantId]],
    );
    expect(usage.rows[0]?.total).toBe(2);

    await expect(platformAdmin.query(`SELECT count(*) FROM users`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(platformAdmin.query(`SELECT count(*) FROM queue_tickets`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      platformAdmin.query(`UPDATE subscriptions SET plan_code = 'PAID_LOCATION'`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('hides tenant rows from the table owner (FORCE) but lets it provision SUPER_ADMIN', async () => {
    const counts = await migrator.query<{ tenants: number; tickets: number }>(
      `SELECT (SELECT count(*)::int FROM tenants) AS tenants,
              (SELECT count(*)::int FROM queue_tickets) AS tickets`,
    );
    expect(counts.rows[0]).toEqual({ tenants: 0, tickets: 0 });

    const email = `super-${tenantA.tenantId.slice(0, 8)}@antre.test`;
    await migrator.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES (NULL, $1, 'hash', 'SUPER_ADMIN')`,
      [email],
    );
    const visible = await migrator.query<{ email: string }>(`SELECT email FROM users`);
    const emails = visible.rows.map((row) => row.email);
    expect(emails).toContain(email);
    expect(emails).not.toContain(tenantA.ownerEmail);

    await expect(
      migrator.query(
        `INSERT INTO users (tenant_id, email, password_hash, role)
         VALUES ($1, 'intruder@example.test', 'hash', 'OWNER')`,
        [tenantA.tenantId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('limits antre_definer to the granted columns', async () => {
    const asDefiner = (sql: string): Promise<pg.QueryResult> =>
      inTransaction(admin, null, async (client) => {
        await client.query('SET LOCAL ROLE antre_definer');
        return client.query(sql);
      });

    const slugs = await asDefiner(`SELECT slug FROM tenants`);
    expect(slugs.rowCount).toBeGreaterThanOrEqual(2);
    await expect(asDefiner(`SELECT name FROM tenants`)).rejects.toMatchObject({ code: '42501' });
    await expect(asDefiner(`SELECT customer_name FROM queue_tickets`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(asDefiner(`UPDATE bookings SET status = 'EXPIRED'`)).rejects.toMatchObject({
      code: '42501',
    });
  });
});
