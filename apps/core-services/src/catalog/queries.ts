// SQL of the catalog API (services, resources, operating hours). All functions run inside a tenant
// transaction (RLS limits rows to the tenant). Money columns are integer rupiah returned as number.
import type {
  CreateResourceRequest,
  CreateServiceRequest,
  OperatingDayDto,
  OperatingHoursDto,
  PutOperatingHoursRequest,
  ResourceDto,
  ServiceDto,
  UpdateResourceRequest,
  UpdateServiceRequest,
} from '@antre/shared-types';
import type pg from 'pg';

export const SERVICE_COLUMNS = `s.id, s.name, s.ticket_prefix, s.avg_duration_min,
  s.price::float8 AS price, s.requires_dp, s.dp_amount::float8 AS dp_amount, s.is_active`;

export async function listServices(client: pg.PoolClient): Promise<ServiceDto[]> {
  const result = await client.query<ServiceDto>(
    `SELECT ${SERVICE_COLUMNS} FROM services s ORDER BY s.name, s.ticket_prefix`,
  );
  return result.rows;
}

export async function insertService(
  client: pg.PoolClient,
  tenantId: string,
  request: CreateServiceRequest,
): Promise<ServiceDto> {
  const result = await client.query<ServiceDto>(
    `INSERT INTO services AS s
       (tenant_id, name, ticket_prefix, avg_duration_min, price, requires_dp, dp_amount, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SERVICE_COLUMNS}`,
    [
      tenantId,
      request.name,
      request.ticket_prefix,
      request.avg_duration_min,
      request.price,
      request.requires_dp,
      request.dp_amount,
      request.is_active,
    ],
  );
  return result.rows[0]!;
}

export async function updateService(
  client: pg.PoolClient,
  id: string,
  request: UpdateServiceRequest,
): Promise<ServiceDto | null> {
  const result = await client.query<ServiceDto>(
    `UPDATE services AS s SET
       name = COALESCE($2, s.name),
       ticket_prefix = COALESCE($3, s.ticket_prefix),
       avg_duration_min = COALESCE($4, s.avg_duration_min),
       price = COALESCE($5, s.price),
       requires_dp = CASE WHEN $6::boolean THEN $7::boolean ELSE s.requires_dp END,
       dp_amount = CASE WHEN $6::boolean THEN $8::numeric ELSE s.dp_amount END,
       is_active = COALESCE($9, s.is_active)
     WHERE s.id = $1
     RETURNING ${SERVICE_COLUMNS}`,
    [
      id,
      request.name ?? null,
      request.ticket_prefix ?? null,
      request.avg_duration_min ?? null,
      request.price ?? null,
      request.requires_dp !== undefined,
      request.requires_dp ?? null,
      request.dp_amount ?? null,
      request.is_active ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

// Resources

const RESOURCE_SELECT = `
  SELECT r.id, r.location_id, r.name, r.resource_type, r.is_active,
         COALESCE(
           array_agg(sr.service_id ORDER BY sr.service_id) FILTER (WHERE sr.service_id IS NOT NULL),
           '{}'::uuid[]
         ) AS service_ids
  FROM resources r
  LEFT JOIN service_resources sr ON sr.resource_id = r.id`;

export async function listResources(
  client: pg.PoolClient,
  locationId: string | undefined,
): Promise<ResourceDto[]> {
  const result = await client.query<ResourceDto>(
    `${RESOURCE_SELECT}
     WHERE ($1::uuid IS NULL OR r.location_id = $1)
     GROUP BY r.id
     ORDER BY r.name, r.id`,
    [locationId ?? null],
  );
  return result.rows;
}

export async function getResource(client: pg.PoolClient, id: string): Promise<ResourceDto | null> {
  const result = await client.query<ResourceDto>(
    `${RESOURCE_SELECT} WHERE r.id = $1 GROUP BY r.id`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function locationVisible(client: pg.PoolClient, id: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM locations WHERE id = $1', [id]);
  return result.rowCount === 1;
}

/** True when every id is a service of the tenant (ids are unique). */
export async function allServicesVisible(
  client: pg.PoolClient,
  serviceIds: string[],
): Promise<boolean> {
  if (serviceIds.length === 0) return true;
  const result = await client.query<{ found: number }>(
    'SELECT count(*)::int AS found FROM services WHERE id = ANY($1::uuid[])',
    [serviceIds],
  );
  return result.rows[0]!.found === serviceIds.length;
}

export async function insertResource(
  client: pg.PoolClient,
  tenantId: string,
  request: CreateResourceRequest,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO resources (tenant_id, location_id, name, resource_type, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [tenantId, request.location_id, request.name, request.resource_type, request.is_active],
  );
  const id = result.rows[0]!.id;
  await replaceResourceServices(client, tenantId, id, request.service_ids);
  return id;
}

/** Updates the resource fields; false when the resource is not visible. Does not touch services. */
export async function updateResource(
  client: pg.PoolClient,
  id: string,
  request: UpdateResourceRequest,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE resources SET
       name = COALESCE($2, name),
       resource_type = CASE WHEN $3::boolean THEN $4 ELSE resource_type END,
       is_active = COALESCE($5, is_active)
     WHERE id = $1`,
    [
      id,
      request.name ?? null,
      request.resource_type !== undefined,
      request.resource_type ?? null,
      request.is_active ?? null,
    ],
  );
  return result.rowCount === 1;
}

export async function replaceResourceServices(
  client: pg.PoolClient,
  tenantId: string,
  resourceId: string,
  serviceIds: string[],
): Promise<void> {
  await client.query('DELETE FROM service_resources WHERE resource_id = $1', [resourceId]);
  if (serviceIds.length === 0) return;
  await client.query(
    `INSERT INTO service_resources (tenant_id, service_id, resource_id)
     SELECT $1, s, $2 FROM unnest($3::uuid[]) AS s`,
    [tenantId, resourceId, serviceIds],
  );
}

// Operating hours

const DAY_COLUMNS = `day_of_week,
  to_char(open_time, 'HH24:MI') AS open_time,
  to_char(close_time, 'HH24:MI') AS close_time,
  to_char(break_start, 'HH24:MI') AS break_start,
  to_char(break_end, 'HH24:MI') AS break_end`;

export async function getOperatingHours(
  client: pg.PoolClient,
  locationId: string,
): Promise<OperatingHoursDto | null> {
  const location = await client.query<{ slot_interval_min: number }>(
    'SELECT slot_interval_min FROM locations WHERE id = $1',
    [locationId],
  );
  if (location.rowCount === 0) return null;
  const days = await client.query<OperatingDayDto>(
    `SELECT ${DAY_COLUMNS} FROM operating_hours WHERE location_id = $1 ORDER BY day_of_week`,
    [locationId],
  );
  return {
    location_id: locationId,
    slot_interval_min: location.rows[0]!.slot_interval_min,
    days: days.rows,
  };
}

/** Replaces the whole week; false when the location is not visible. */
export async function putOperatingHours(
  client: pg.PoolClient,
  tenantId: string,
  locationId: string,
  request: PutOperatingHoursRequest,
): Promise<boolean> {
  const updated = await client.query('UPDATE locations SET slot_interval_min = $2 WHERE id = $1', [
    locationId,
    request.slot_interval_min,
  ]);
  if (updated.rowCount === 0) return false;
  await client.query('DELETE FROM operating_hours WHERE location_id = $1', [locationId]);
  for (const day of request.days) {
    await client.query(
      `INSERT INTO operating_hours
         (tenant_id, location_id, day_of_week, open_time, close_time, break_start, break_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        locationId,
        day.day_of_week,
        day.open_time,
        day.close_time,
        day.break_start,
        day.break_end,
      ],
    );
  }
  return true;
}
