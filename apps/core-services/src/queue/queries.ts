// SQL of the queue service (spec sections 6.3, 7.3). Every function runs in a tenant transaction.
// Time comes in as `$now` (an ISO string from deps.now()), never from the database clock, so the
// operating day can be tested. The local day, weekday, time, and month are all computed in SQL, so
// results never depend on the time zone of the Node process.
import type { ServiceDto, TicketChannel, TicketStatus } from '@antre/shared-types';
import type pg from 'pg';

import { SERVICE_COLUMNS } from '../catalog/queries.js';

/** Queue order of a ticket: its sequence number (created_at is not serialised by the lock). */
export const TICKET_SEQ = "split_part(t.ticket_number, '-', 2)::int";

// Location context

export interface LocationContext {
  id: string;
  code: string;
  timezone: string;
  is_active: boolean;
  tenant_name: string;
  service_mode: 'WALK_IN' | 'RESERVATION' | 'BOTH';
  show_wait_estimate: boolean;
  admin_wa_phone: string;
  /** Operating day at `now` in the location's time zone, YYYY-MM-DD. */
  service_date: string;
  /** First day of the local month, YYYY-MM-DD. */
  period_month: string;
  /** Whether `now` lies within today's opening hours and outside the break. */
  open_now: boolean;
  /** The Super Admin suspended the tenant or the location (S11): no new tickets or holds. */
  suspended: boolean;
}

/** Null when the location is not visible to the tenant (404). */
export async function getLocationContext(
  client: pg.PoolClient,
  locationId: string,
  now: string,
): Promise<LocationContext | null> {
  const result = await client.query<LocationContext>(
    `SELECT l.id, l.code, l.timezone, l.is_active, t.name AS tenant_name, t.service_mode,
            t.show_wait_estimate, t.admin_wa_phone,
            c.local_ts::date::text AS service_date,
            date_trunc('month', c.local_ts)::date::text AS period_month,
            (oh.id IS NOT NULL
              AND c.local_ts::time >= oh.open_time AND c.local_ts::time < oh.close_time
              AND NOT (oh.break_start IS NOT NULL
                       AND c.local_ts::time >= oh.break_start AND c.local_ts::time < oh.break_end)
            ) AS open_now,
            (l.suspended_at IS NOT NULL OR t.suspended_at IS NOT NULL) AS suspended
     FROM locations l
     JOIN tenants t ON t.id = l.tenant_id
     CROSS JOIN LATERAL (SELECT ($2::timestamptz AT TIME ZONE l.timezone) AS local_ts) c
     LEFT JOIN operating_hours oh
       ON oh.location_id = l.id AND oh.day_of_week = EXTRACT(DOW FROM c.local_ts)::int
     WHERE l.id = $1`,
    [locationId, now],
  );
  return result.rows[0] ?? null;
}

/** Lazy end-of-day close (spec section 6.3): tickets of earlier operating days become EXPIRED. */
export async function expireStaleTickets(
  client: pg.PoolClient,
  locationId: string,
  now: string,
): Promise<void> {
  await client.query(
    `UPDATE queue_tickets AS t SET status = 'EXPIRED'
     FROM locations AS l
     WHERE l.id = t.location_id AND t.location_id = $1
       AND t.status IN ('WAITING', 'CALLED', 'SERVING')
       AND t.service_date < ($2::timestamptz AT TIME ZONE l.timezone)::date`,
    [locationId, now],
  );
}

// Creating a ticket

export interface TicketService {
  id: string;
  name: string;
  ticket_prefix: string;
  avg_duration_min: number;
}

/** The service when it is active and served by an active resource of the location. */
export async function getTicketService(
  client: pg.PoolClient,
  serviceId: string,
  locationId: string,
): Promise<TicketService | null> {
  const result = await client.query<TicketService>(
    `SELECT s.id, s.name, s.ticket_prefix, s.avg_duration_min
     FROM services s
     WHERE s.id = $1 AND s.is_active
       AND EXISTS (
         SELECT 1 FROM service_resources sr JOIN resources r ON r.id = sr.resource_id
         WHERE sr.service_id = s.id AND r.location_id = $2 AND r.is_active
       )`,
    [serviceId, locationId],
  );
  return result.rows[0] ?? null;
}

export async function findActiveTicketId(
  client: pg.PoolClient,
  locationId: string,
  phone: string,
  serviceDate: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM queue_tickets
     WHERE location_id = $1 AND customer_phone = $2 AND service_date = $3::date
       AND status IN ('WAITING', 'CALLED', 'SERVING')`,
    [locationId, phone, serviceDate],
  );
  return result.rows[0]?.id ?? null;
}

export interface QuotaUsage {
  ticket_count: number;
  plan_code: string;
  monthly_ticket_quota: number | null;
  warning_sent_at: Date | null;
  exceeded_sent_at: Date | null;
}

/** Spec section 7.3: counts one ticket against the monthly quota; null when the quota is used up. */
export async function reserveQuota(
  client: pg.PoolClient,
  tenantId: string,
  locationId: string,
  periodMonth: string,
): Promise<QuotaUsage | null> {
  await client.query(
    `INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
     VALUES ($1, $2, $3::date, 0) ON CONFLICT (location_id, period_month) DO NOTHING`,
    [tenantId, locationId, periodMonth],
  );
  const result = await client.query<QuotaUsage>(
    `UPDATE usage_counters AS uc SET ticket_count = uc.ticket_count + 1
     FROM subscriptions AS s JOIN plans AS p ON p.code = s.plan_code
     WHERE uc.location_id = $1 AND uc.period_month = $2::date AND s.location_id = uc.location_id
       AND (p.monthly_ticket_quota IS NULL OR uc.ticket_count < p.monthly_ticket_quota)
     RETURNING uc.ticket_count, p.code AS plan_code, p.monthly_ticket_quota,
               uc.warning_sent_at, uc.exceeded_sent_at`,
    [locationId, periodMonth],
  );
  return result.rows[0] ?? null;
}

export async function markQuotaNotified(
  client: pg.PoolClient,
  kind: 'warning' | 'exceeded',
  locationId: string,
  periodMonth: string,
  now: string,
): Promise<void> {
  const column = kind === 'warning' ? 'warning_sent_at' : 'exceeded_sent_at';
  await client.query(
    `UPDATE usage_counters SET ${column} = $3::timestamptz
     WHERE location_id = $1 AND period_month = $2::date`,
    [locationId, periodMonth, now],
  );
}

/** Next sequence number of the (location, service, day) counter; the row lock serialises creators. */
export async function nextSequence(
  client: pg.PoolClient,
  tenantId: string,
  locationId: string,
  serviceId: string,
  serviceDate: string,
): Promise<number> {
  const result = await client.query<{ last_seq: number }>(
    `INSERT INTO ticket_counters (tenant_id, location_id, service_id, service_date, last_seq)
     VALUES ($1, $2, $3, $4::date, 1)
     ON CONFLICT (location_id, service_id, service_date)
     DO UPDATE SET last_seq = ticket_counters.last_seq + 1
     RETURNING last_seq`,
    [tenantId, locationId, serviceId, serviceDate],
  );
  return result.rows[0]!.last_seq;
}

export async function countPeopleAhead(
  client: pg.PoolClient,
  locationId: string,
  serviceId: string,
  serviceDate: string,
  seq: number,
): Promise<number> {
  const result = await client.query<{ people_ahead: number }>(
    `SELECT count(*)::int AS people_ahead FROM queue_tickets t
     WHERE t.location_id = $1 AND t.service_id = $2 AND t.service_date = $3::date
       AND t.status = 'WAITING' AND ${TICKET_SEQ} < $4`,
    [locationId, serviceId, serviceDate, seq],
  );
  return result.rows[0]!.people_ahead;
}

export interface NewTicket {
  tenantId: string;
  locationId: string;
  serviceId: string;
  serviceDate: string;
  ticketNumber: string;
  channel: TicketChannel;
  customerName: string;
  customerPhone: string | null;
  estimatedServeTime: string;
  nearTurnNotifiedAt: string | null;
  createdAt: string;
}

export async function insertTicket(client: pg.PoolClient, ticket: NewTicket): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO queue_tickets
       (tenant_id, location_id, service_id, service_date, ticket_number, channel, customer_name,
        customer_phone, estimated_serve_time, near_turn_notified_at, created_at)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz)
     RETURNING id`,
    [
      ticket.tenantId,
      ticket.locationId,
      ticket.serviceId,
      ticket.serviceDate,
      ticket.ticketNumber,
      ticket.channel,
      ticket.customerName,
      ticket.customerPhone,
      ticket.estimatedServeTime,
      ticket.nearTurnNotifiedAt,
      ticket.createdAt,
    ],
  );
  return result.rows[0]!.id;
}

// CALL_NEXT and CANCEL

/**
 * Per-queue mutex: locks the day's counter row of the (location, service). CALL_NEXT and CANCEL
 * run under it, which gives strict FIFO, exactly-once calls, and a stable "people ahead" view.
 * Returns false when no ticket was ever taken today (an empty queue).
 */
export async function lockQueue(
  client: pg.PoolClient,
  locationId: string,
  serviceId: string,
  serviceDate: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM ticket_counters
     WHERE location_id = $1 AND service_id = $2 AND service_date = $3::date FOR UPDATE`,
    [locationId, serviceId, serviceDate],
  );
  return result.rowCount === 1;
}

export interface CallResource {
  id: string;
  name: string;
}

/** The resource when it is active, at the location, and linked to the service. */
export async function getCallResource(
  client: pg.PoolClient,
  resourceId: string,
  locationId: string,
  serviceId: string,
): Promise<CallResource | null> {
  const result = await client.query<CallResource>(
    `SELECT r.id, r.name FROM resources r
     JOIN service_resources sr ON sr.resource_id = r.id
     WHERE r.id = $1 AND r.location_id = $2 AND r.is_active AND sr.service_id = $3`,
    [resourceId, locationId, serviceId],
  );
  return result.rows[0] ?? null;
}

/** Calls the oldest WAITING ticket; call under lockQueue. Returns its id or null. */
export async function callOldestWaiting(
  client: pg.PoolClient,
  locationId: string,
  serviceId: string,
  serviceDate: string,
  resourceId: string,
  now: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `WITH next AS (
       SELECT t.id FROM queue_tickets t
       WHERE t.location_id = $1 AND t.service_id = $2 AND t.service_date = $3::date
         AND t.status = 'WAITING'
       ORDER BY ${TICKET_SEQ}
       LIMIT 1 FOR UPDATE
     )
     UPDATE queue_tickets AS t SET status = 'CALLED', resource_id = $4, called_at = $5::timestamptz
     FROM next WHERE t.id = next.id RETURNING t.id`,
    [locationId, serviceId, serviceDate, resourceId, now],
  );
  return result.rows[0]?.id ?? null;
}

/** Marks WAITING tickets with at most two people ahead that were not notified yet; returns ids. */
export async function markNearTurn(
  client: pg.PoolClient,
  locationId: string,
  serviceId: string,
  serviceDate: string,
  now: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `WITH ranked AS (
       SELECT t.id, (row_number() OVER (ORDER BY ${TICKET_SEQ}) - 1)::int AS ahead
       FROM queue_tickets t
       WHERE t.location_id = $1 AND t.service_id = $2 AND t.service_date = $3::date
         AND t.status = 'WAITING'
     )
     UPDATE queue_tickets AS t SET near_turn_notified_at = $4::timestamptz
     FROM ranked AS r
     WHERE t.id = r.id AND r.ahead <= 2 AND t.near_turn_notified_at IS NULL
     RETURNING t.id`,
    [locationId, serviceId, serviceDate, now],
  );
  return result.rows.map((row) => row.id);
}

// Ticket actions

export interface TicketHandle {
  id: string;
  location_id: string;
  service_id: string;
}

/** Finds a ticket by id (and customer phone when given); null when RLS hides it or the phone differs. */
export async function findTicket(
  client: pg.PoolClient,
  id: string,
  customerPhone?: string,
): Promise<TicketHandle | null> {
  const result = await client.query<TicketHandle>(
    `SELECT id, location_id, service_id FROM queue_tickets
     WHERE id = $1 AND ($2::text IS NULL OR customer_phone = $2)`,
    [id, customerPhone ?? null],
  );
  return result.rows[0] ?? null;
}

export type StaffTicketAction = 'RECALL' | 'SERVE' | 'COMPLETE' | 'NO_SHOW';

// Static SET clauses ($3 is `now`); never built from user input.
const ACTION_SET: Record<StaffTicketAction, string> = {
  RECALL: 'recall_count = recall_count + 1',
  SERVE: "status = 'SERVING', serving_at = $3::timestamptz",
  COMPLETE: "status = 'COMPLETED', completed_at = $3::timestamptz",
  NO_SHOW: "status = 'NO_SHOW'",
};

/** Conditional transition; false when the ticket is not in one of the `from` statuses. */
export async function transitionTicket(
  client: pg.PoolClient,
  id: string,
  action: StaffTicketAction,
  from: readonly TicketStatus[],
  now: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE queue_tickets SET ${ACTION_SET[action]} WHERE id = $1 AND status = ANY($2::text[])`,
    // Only the SERVE and COMPLETE clauses refer to $3: an unused parameter would be rejected.
    action === 'SERVE' || action === 'COMPLETE' ? [id, from, now] : [id, from],
  );
  return result.rowCount === 1;
}

export async function cancelWaitingTicket(client: pg.PoolClient, id: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE queue_tickets SET status = 'CANCELLED' WHERE id = $1 AND status = 'WAITING'`,
    [id],
  );
  return result.rowCount === 1;
}

// Reading tickets

export interface TicketRow {
  id: string;
  location_id: string;
  service_id: string;
  service_name: string;
  avg_duration_min: number;
  resource_id: string | null;
  resource_name: string | null;
  service_date: string;
  ticket_number: string;
  channel: TicketChannel;
  customer_name: string;
  customer_phone: string | null;
  status: TicketStatus;
  recall_count: number;
  /** Number of WAITING tickets before this one; meaningful for WAITING tickets only. */
  people_ahead: number;
  called_at: Date | null;
  serving_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export interface TicketFilter {
  statuses?: readonly TicketStatus[];
  ids?: readonly string[];
  customerPhone?: string;
}

/**
 * Tickets of one operating day of a location, ordered by service name and sequence. `people_ahead`
 * is computed over all tickets of the day BEFORE the filter, so a filtered result stays correct.
 */
export async function selectTickets(
  client: pg.PoolClient,
  locationId: string,
  serviceDate: string,
  filter: TicketFilter = {},
): Promise<TicketRow[]> {
  const result = await client.query<TicketRow>(
    `SELECT x.id, x.location_id, x.service_id, x.service_name, x.avg_duration_min, x.resource_id,
            x.resource_name, x.service_date, x.ticket_number, x.channel, x.customer_name,
            x.customer_phone, x.status, x.recall_count, x.people_ahead, x.called_at, x.serving_at,
            x.completed_at, x.created_at
     FROM (
       SELECT t.id, t.location_id, t.service_id, s.name AS service_name, s.avg_duration_min,
              t.resource_id, r.name AS resource_name, t.service_date::text AS service_date,
              t.ticket_number, t.channel, t.customer_name, t.customer_phone, t.status,
              t.recall_count, ${TICKET_SEQ} AS seq,
              GREATEST(
                count(*) FILTER (WHERE t.status = 'WAITING')
                  OVER (PARTITION BY t.service_id ORDER BY ${TICKET_SEQ}) - 1,
                0
              )::int AS people_ahead,
              t.called_at, t.serving_at, t.completed_at, t.created_at
       FROM queue_tickets t
       JOIN services s ON s.id = t.service_id
       LEFT JOIN resources r ON r.id = t.resource_id
       WHERE t.location_id = $1 AND t.service_date = $2::date
     ) x
     WHERE ($3::text[] IS NULL OR x.status = ANY($3::text[]))
       AND ($4::uuid[] IS NULL OR x.id = ANY($4::uuid[]))
       AND ($5::text IS NULL OR x.customer_phone = $5)
     ORDER BY x.service_name, x.seq`,
    [
      locationId,
      serviceDate,
      filter.statuses ? [...filter.statuses] : null,
      filter.ids ? [...filter.ids] : null,
      filter.customerPhone ?? null,
    ],
  );
  return result.rows;
}

/** Active services of the tenant; with a location, only those an active resource there serves. */
export async function listActiveServices(
  client: pg.PoolClient,
  locationId: string | undefined,
): Promise<ServiceDto[]> {
  const result = await client.query<ServiceDto>(
    `SELECT ${SERVICE_COLUMNS} FROM services s
     WHERE s.is_active
       AND ($1::uuid IS NULL OR EXISTS (
         SELECT 1 FROM service_resources sr JOIN resources r ON r.id = sr.resource_id
         WHERE sr.service_id = s.id AND r.location_id = $1 AND r.is_active
       ))
     ORDER BY s.name, s.ticket_prefix`,
    [locationId ?? null],
  );
  return result.rows;
}
