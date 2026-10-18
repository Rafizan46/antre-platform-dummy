// Shared helpers for the integration tests: role-specific pools, tenant-scoped transactions,
// and fixtures created the way the services will create them (antre_app under RLS).
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { inject } from 'vitest';

import type { DatabaseUrls } from './database.js';

export type DatabaseRole = keyof DatabaseUrls;

export function createPool(role: DatabaseRole, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: inject('databaseUrls')[role], max });
}

/**
 * Runs `work` in one transaction. A non-null `tenantId` is set with
 * set_config('app.current_tenant_id', ..., true), the parameterised form of SET LOCAL.
 */
export async function inTransaction<T>(
  pool: pg.Pool,
  tenantId: string | null,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface TenantFixture {
  tenantId: string;
  slug: string;
  ownerEmail: string;
  locationId: string;
  locationCode: string;
  serviceId: string;
  resourceId: string;
}

/**
 * Registers a tenant like FR-AUTH-01 / spec section 6.1 point 6: one transaction in the new
 * tenant context creating the tenant, its OWNER, the first location with a FREE subscription,
 * plus one service and one resource linked through service_resources.
 */
export async function createTenant(appPool: pg.Pool): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const fixture: TenantFixture = {
    tenantId,
    slug: `tenant-${suffix}`,
    ownerEmail: `owner-${suffix}@example.test`,
    locationId: randomUUID(),
    locationCode: 'pusat',
    serviceId: randomUUID(),
    resourceId: randomUUID(),
  };

  await inTransaction(appPool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, slug, business_type, admin_wa_phone)
       VALUES ($1, $2, $3, 'CLINIC', '6281100000000')`,
      [tenantId, `Tenant ${suffix}`, fixture.slug],
    );
    await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'hash', 'OWNER')`,
      [tenantId, fixture.ownerEmail],
    );
    await client.query(
      `INSERT INTO locations (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Pusat')`,
      [fixture.locationId, tenantId, fixture.locationCode],
    );
    await client.query(`INSERT INTO subscriptions (tenant_id, location_id) VALUES ($1, $2)`, [
      tenantId,
      fixture.locationId,
    ]);
    await client.query(
      `INSERT INTO services (id, tenant_id, name, ticket_prefix, avg_duration_min)
       VALUES ($1, $2, 'Umum', 'A', 10)`,
      [fixture.serviceId, tenantId],
    );
    await client.query(
      `INSERT INTO resources (id, tenant_id, location_id, name) VALUES ($1, $2, $3, 'Loket 1')`,
      [fixture.resourceId, tenantId, fixture.locationId],
    );
    await client.query(
      `INSERT INTO service_resources (tenant_id, service_id, resource_id) VALUES ($1, $2, $3)`,
      [tenantId, fixture.serviceId, fixture.resourceId],
    );
  });

  return fixture;
}

/** SQL expression: today's operating date of the fixture location (Asia/Jakarta). */
export const TODAY_SQL = "(now() AT TIME ZONE 'Asia/Jakarta')::date";

export interface TicketValues {
  ticketNumber: string;
  customerPhone: string | null;
  status?: string;
  /** Days relative to today's operating date (0 = today, -1 = yesterday). */
  dayOffset?: number;
}

export async function insertTicket(
  client: pg.PoolClient,
  fixture: TenantFixture,
  values: TicketValues,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO queue_tickets
       (tenant_id, location_id, service_id, service_date, ticket_number, channel,
        customer_name, customer_phone, status)
     VALUES ($1, $2, $3, ${TODAY_SQL} + $4::int, $5,
             CASE WHEN $6::text IS NULL THEN 'STAFF' ELSE 'WHATSAPP' END,
             'Pelanggan', $6::text, $7)
     RETURNING id`,
    [
      fixture.tenantId,
      fixture.locationId,
      fixture.serviceId,
      values.dayOffset ?? 0,
      values.ticketNumber,
      values.customerPhone,
      values.status ?? 'WAITING',
    ],
  );
  return result.rows[0]!.id;
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

export interface BookingValues {
  customerPhone: string;
  startTime: Date;
  /** PENDING_PAYMENT bookings get a DP (UNPAID); every other status is created without DP. */
  status: 'PENDING_PAYMENT' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
  /** PENDING_PAYMENT only; defaults to 5 minutes from now. */
  holdExpiresAt?: Date;
}

export async function insertBooking(
  client: pg.PoolClient,
  fixture: TenantFixture,
  values: BookingValues,
): Promise<string> {
  const withDp = values.status === 'PENDING_PAYMENT';
  const result = await client.query<{ id: string }>(
    `INSERT INTO bookings
       (tenant_id, location_id, resource_id, service_id, customer_name, customer_phone,
        start_time, end_time, status, hold_token, hold_expires_at, dp_amount,
        payment_status, payment_ref)
     VALUES ($1, $2, $3, $4, 'Pelanggan', $5, $6, $6::timestamptz + interval '1 hour', $7,
             gen_random_uuid(),
             CASE WHEN $8::boolean THEN $9::timestamptz END,
             CASE WHEN $8::boolean THEN 50000 END,
             CASE WHEN $8::boolean THEN 'UNPAID' ELSE 'NOT_REQUIRED' END,
             CASE WHEN $8::boolean THEN 'pay-' || gen_random_uuid() END)
     RETURNING id`,
    [
      fixture.tenantId,
      fixture.locationId,
      fixture.resourceId,
      fixture.serviceId,
      values.customerPhone,
      values.startTime,
      values.status,
      withDp,
      values.holdExpiresAt ?? minutesFromNow(5),
    ],
  );
  return result.rows[0]!.id;
}
