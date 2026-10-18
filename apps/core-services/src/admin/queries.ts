// Super Admin console queries (FR-ADMIN-01). They run on the antre_platform_admin pool: no tenant
// context, cross-tenant SELECT on tenants, locations, plans, subscriptions, and usage_counters only
// (policy platform_admin_read), plus UPDATE of suspended_at (migration 1792371600000, S11).
import type pg from 'pg';

export interface AdminLocationRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  timezone: string;
  is_active: boolean;
  suspended_at: Date | null;
  plan_code: string | null;
  subscription_status: string | null;
  current_period_end: Date | null;
  period_month: string;
  ticket_count: number;
  monthly_ticket_quota: number | null;
}

export interface AdminTenantRow {
  id: string;
  name: string;
  slug: string;
  business_type: string;
  service_mode: string;
  created_at: Date;
  suspended_at: Date | null;
}

export type TenantStatusFilter = 'active' | 'suspended' | undefined;

const STATUS_SQL = `($1::text IS NULL
  OR ($1 = 'suspended' AND t.suspended_at IS NOT NULL)
  OR ($1 = 'active' AND t.suspended_at IS NULL))`;

export async function listTenants(
  client: pg.PoolClient,
  filter: { status?: TenantStatusFilter; limit: number; offset: number },
): Promise<{ total: number; rows: AdminTenantRow[] }> {
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM tenants t WHERE ${STATUS_SQL}`,
    [filter.status ?? null],
  );
  const rows = await client.query<AdminTenantRow>(
    `SELECT t.id, t.name, t.slug, t.business_type, t.service_mode, t.created_at, t.suspended_at
     FROM tenants t WHERE ${STATUS_SQL}
     ORDER BY t.created_at, t.id LIMIT $2 OFFSET $3`,
    [filter.status ?? null, filter.limit, filter.offset],
  );
  return { total: total.rows[0]?.total ?? 0, rows: rows.rows };
}

export async function getTenant(client: pg.PoolClient, id: string): Promise<AdminTenantRow | null> {
  const result = await client.query<AdminTenantRow>(
    `SELECT t.id, t.name, t.slug, t.business_type, t.service_mode, t.created_at, t.suspended_at
     FROM tenants t WHERE t.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Locations of the tenants with plan, status, and usage of their local month at `nowIso`. */
export async function locationsOf(
  client: pg.PoolClient,
  tenantIds: string[],
  nowIso: string,
): Promise<AdminLocationRow[]> {
  if (tenantIds.length === 0) return [];
  const result = await client.query<AdminLocationRow>(
    `SELECT l.id, l.tenant_id, l.code, l.name, l.timezone, l.is_active, l.suspended_at,
            s.plan_code, s.status AS subscription_status, s.current_period_end,
            m.period_month::text AS period_month,
            COALESCE(uc.ticket_count, 0) AS ticket_count, p.monthly_ticket_quota
     FROM locations l
     CROSS JOIN LATERAL (
       SELECT date_trunc('month', $2::timestamptz AT TIME ZONE l.timezone)::date AS period_month
     ) m
     LEFT JOIN subscriptions s ON s.location_id = l.id
     LEFT JOIN plans p ON p.code = s.plan_code
     LEFT JOIN usage_counters uc ON uc.location_id = l.id AND uc.period_month = m.period_month
     WHERE l.tenant_id = ANY ($1::uuid[])
     ORDER BY l.created_at, l.id`,
    [tenantIds, nowIso],
  );
  return result.rows;
}

export interface AdminUsageRow {
  tenant_id: string;
  tenant_slug: string;
  location_id: string;
  location_code: string;
  plan_code: string | null;
  period_month: string;
  ticket_count: number;
  monthly_ticket_quota: number | null;
}

/** Monthly usage per location: `periodMonth` (YYYY-MM-01) or each location's local month. */
export async function usageByLocation(
  client: pg.PoolClient,
  periodMonth: string | null,
  nowIso: string,
): Promise<AdminUsageRow[]> {
  const result = await client.query<AdminUsageRow>(
    `SELECT t.id AS tenant_id, t.slug AS tenant_slug, l.id AS location_id, l.code AS location_code,
            s.plan_code, m.period_month::text AS period_month,
            COALESCE(uc.ticket_count, 0) AS ticket_count, p.monthly_ticket_quota
     FROM locations l
     JOIN tenants t ON t.id = l.tenant_id
     CROSS JOIN LATERAL (
       SELECT COALESCE($1::date,
                       date_trunc('month', $2::timestamptz AT TIME ZONE l.timezone)::date)
              AS period_month
     ) m
     LEFT JOIN subscriptions s ON s.location_id = l.id
     LEFT JOIN plans p ON p.code = s.plan_code
     LEFT JOIN usage_counters uc ON uc.location_id = l.id AND uc.period_month = m.period_month
     ORDER BY t.slug, l.code`,
    [periodMonth, nowIso],
  );
  return result.rows;
}

export async function usageHistoryOf(
  client: pg.PoolClient,
  locationIds: string[],
  months: number,
): Promise<{ location_id: string; period_month: string; ticket_count: number }[]> {
  if (locationIds.length === 0) return [];
  const result = await client.query<{
    location_id: string;
    period_month: string;
    ticket_count: number;
  }>(
    `SELECT location_id, period_month::text AS period_month, ticket_count
     FROM (SELECT uc.*, row_number() OVER (PARTITION BY location_id ORDER BY period_month DESC) AS n
           FROM usage_counters uc WHERE location_id = ANY ($1::uuid[])) h
     WHERE n <= $2
     ORDER BY location_id, period_month DESC`,
    [locationIds, months],
  );
  return result.rows;
}

/** Sets (keeps the first) or clears suspended_at; null when the row does not exist. */
export async function setSuspended(
  client: pg.PoolClient,
  table: 'tenants' | 'locations',
  id: string,
  suspended: boolean,
  nowIso: string,
): Promise<{ id: string; suspended_at: Date | null } | null> {
  const result = suspended
    ? await client.query<{ id: string; suspended_at: Date | null }>(
        `UPDATE ${table} SET suspended_at = COALESCE(suspended_at, $2::timestamptz)
         WHERE id = $1 RETURNING id, suspended_at`,
        [id, nowIso],
      )
    : await client.query<{ id: string; suspended_at: Date | null }>(
        `UPDATE ${table} SET suspended_at = NULL WHERE id = $1 RETURNING id, suspended_at`,
        [id],
      );
  return result.rows[0] ?? null;
}
