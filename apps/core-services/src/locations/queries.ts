// SQL of the locations API. All functions run inside withTenant (RLS limits rows to the tenant).
import type {
  CreateLocationRequest,
  LocationDto,
  UpdateLocationRequest,
} from '@antre/shared-types';
import type pg from 'pg';

const LOCATION_COLUMNS = 'id, code, name, address, timezone, slot_interval_min, is_active';

export async function listLocations(client: pg.PoolClient): Promise<LocationDto[]> {
  const result = await client.query<LocationDto>(
    `SELECT ${LOCATION_COLUMNS} FROM locations ORDER BY name, code`,
  );
  return result.rows;
}

/** Inserts the location and its FREE subscription. Unique violations bubble up to the route. */
export async function insertLocation(
  client: pg.PoolClient,
  tenantId: string,
  request: CreateLocationRequest,
): Promise<LocationDto> {
  const result = await client.query<LocationDto>(
    `INSERT INTO locations (tenant_id, code, name, address, timezone, slot_interval_min)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${LOCATION_COLUMNS}`,
    [
      tenantId,
      request.code,
      request.name,
      request.address ?? null,
      request.timezone,
      request.slot_interval_min,
    ],
  );
  const location = result.rows[0]!;
  await client.query('INSERT INTO subscriptions (tenant_id, location_id) VALUES ($1, $2)', [
    tenantId,
    location.id,
  ]);
  return location;
}

export async function updateLocation(
  client: pg.PoolClient,
  id: string,
  request: UpdateLocationRequest,
): Promise<LocationDto | null> {
  const result = await client.query<LocationDto>(
    `UPDATE locations SET
       name = COALESCE($2, name),
       address = CASE WHEN $3::boolean THEN $4 ELSE address END,
       timezone = COALESCE($5, timezone),
       slot_interval_min = COALESCE($6, slot_interval_min),
       is_active = COALESCE($7, is_active)
     WHERE id = $1
     RETURNING ${LOCATION_COLUMNS}`,
    [
      id,
      request.name ?? null,
      request.address !== undefined,
      request.address ?? null,
      request.timezone ?? null,
      request.slot_interval_min ?? null,
      request.is_active ?? null,
    ],
  );
  return result.rows[0] ?? null;
}
