// SQL of the WhatsApp Channel Service endpoints that run before or across tenants (spec sections
// 6.1, 8). Location resolution and the phone search use the SECURITY DEFINER functions of the
// closed list on the antre_app pool without a tenant context; the WhatsApp context runs inside
// the tenant transaction of X-Antre-Tenant-Id, so RLS applies.
import type {
  ActiveItemDto,
  LocationTimezone,
  ResolveLocationResponse,
  ServiceMode,
  WaContextDto,
} from '@antre/shared-types';
import type pg from 'pg';

/** app_resolve_location: active location of `slug` + `code`, or null. */
export async function resolveLocation(
  pool: pg.Pool,
  slug: string,
  code: string,
): Promise<ResolveLocationResponse | null> {
  const result = await pool.query<ResolveLocationResponse>(
    'SELECT tenant_id, location_id FROM app_resolve_location($1, $2)',
    [slug, code],
  );
  return result.rows[0] ?? null;
}

/** app_find_active_by_phone: active tickets of today and upcoming bookings in all tenants. */
export async function findActiveItems(pool: pg.Pool, phone: string): Promise<ActiveItemDto[]> {
  const result = await pool.query<ActiveItemDto>(
    'SELECT kind, tenant_id, location_id, item_id FROM app_find_active_by_phone($1)',
    [phone],
  );
  return result.rows;
}

interface WaContextRow {
  tenant_id: string;
  tenant_name: string;
  id: string;
  code: string;
  name: string;
  timezone: LocationTimezone;
  is_active: boolean;
  service_mode: ServiceMode;
  show_wait_estimate: boolean;
  wa_greeting: string | null;
  resource_label: string | null;
}

/** Names, mode, estimate toggle, and branding of a location of the current tenant (FR-WA-04). */
export async function getWaContext(
  client: pg.PoolClient,
  locationId: string,
): Promise<WaContextDto | null> {
  const result = await client.query<WaContextRow>(
    `SELECT t.id AS tenant_id, t.name AS tenant_name, l.id, l.code, l.name, l.timezone,
            (l.is_active AND l.suspended_at IS NULL AND t.suspended_at IS NULL) AS is_active,
            t.service_mode, t.show_wait_estimate,
            NULLIF(btrim(t.branding->>'wa_greeting'), '') AS wa_greeting,
            NULLIF(btrim(t.branding#>>'{labels,resource}'), '') AS resource_label
     FROM locations l
     JOIN tenants t ON t.id = l.tenant_id
     WHERE l.id = $1`,
    [locationId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    tenant: { id: row.tenant_id, name: row.tenant_name },
    location: {
      id: row.id,
      code: row.code,
      name: row.name,
      timezone: row.timezone,
      is_active: row.is_active,
    },
    service_mode: row.service_mode,
    show_wait_estimate: row.show_wait_estimate,
    branding: { wa_greeting: row.wa_greeting, resource_label: row.resource_label },
  };
}
