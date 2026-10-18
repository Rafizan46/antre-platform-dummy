// SQL of the tenant settings module (tenant-scoped transaction; RLS limits rows to the tenant).
import type {
  Branding,
  BusinessType,
  ServiceMode,
  TenantSettingsDto,
  UpdateTenantSettingsRequest,
} from '@antre/shared-types';
import type pg from 'pg';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  business_type: BusinessType;
  service_mode: ServiceMode;
  show_wait_estimate: boolean;
  admin_wa_phone: string;
  branding: Branding;
}

const TENANT_COLUMNS =
  'id, name, slug, business_type, service_mode, show_wait_estimate, admin_wa_phone, branding';

function toSettingsDto(row: TenantRow): TenantSettingsDto {
  return { ...row };
}

export async function getTenantSettings(
  client: pg.PoolClient,
  tenantId: string,
): Promise<TenantSettingsDto | null> {
  const result = await client.query<TenantRow>(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  return row ? toSettingsDto(row) : null;
}

export async function updateTenantSettings(
  client: pg.PoolClient,
  tenantId: string,
  values: UpdateTenantSettingsRequest,
): Promise<TenantSettingsDto | null> {
  const result = await client.query<TenantRow>(
    `UPDATE tenants
     SET service_mode = COALESCE($2, service_mode),
         show_wait_estimate = COALESCE($3, show_wait_estimate),
         admin_wa_phone = COALESCE($4, admin_wa_phone),
         branding = COALESCE($5::jsonb, branding)
     WHERE id = $1
     RETURNING ${TENANT_COLUMNS}`,
    [
      tenantId,
      values.service_mode ?? null,
      values.show_wait_estimate ?? null,
      values.admin_wa_phone ?? null,
      values.branding === undefined ? null : JSON.stringify(values.branding),
    ],
  );
  const row = result.rows[0];
  return row ? toSettingsDto(row) : null;
}
