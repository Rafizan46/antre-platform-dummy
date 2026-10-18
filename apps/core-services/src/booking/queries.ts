// SQL of the booking service (spec sections 6.3, 7.2, 7.4). Every function runs in a tenant
// transaction. Time comes in as an ISO string from deps.now(); the local day, weekday, and slot
// grid are computed in SQL from the location's time zone, never from the Node process time zone.
import type { BookingStatus, PaymentStatus } from '@antre/shared-types';
import type pg from 'pg';

// Slots

export interface SlotRow {
  start_time: Date;
  end_time: Date;
}

export async function getSlotInterval(
  client: pg.PoolClient,
  locationId: string,
): Promise<number | null> {
  const result = await client.query<{ slot_interval_min: number }>(
    'SELECT slot_interval_min FROM locations WHERE id = $1',
    [locationId],
  );
  return result.rows[0]?.slot_interval_min ?? null;
}

/** The local calendar day (YYYY-MM-DD) of an instant at the location. */
export async function localDateOf(
  client: pg.PoolClient,
  locationId: string,
  instant: string,
): Promise<string | null> {
  const result = await client.query<{ local_date: string }>(
    `SELECT ($2::timestamptz AT TIME ZONE l.timezone)::date::text AS local_date
     FROM locations l WHERE l.id = $1`,
    [locationId, instant],
  );
  return result.rows[0]?.local_date ?? null;
}

/** Q1: the slot grid of one local day: opening hours cut into `slot_interval_min` steps, minus the break. */
export async function listSlots(
  client: pg.PoolClient,
  locationId: string,
  localDate: string,
): Promise<SlotRow[]> {
  const result = await client.query<SlotRow>(
    `SELECT gs.local_start AT TIME ZONE l.timezone AS start_time,
            (gs.local_start + make_interval(mins => l.slot_interval_min)) AT TIME ZONE l.timezone
              AS end_time
     FROM locations l
     JOIN operating_hours oh
       ON oh.location_id = l.id AND oh.day_of_week = EXTRACT(DOW FROM $2::date)::int
     CROSS JOIN LATERAL generate_series(
         $2::date + oh.open_time,
         $2::date + oh.close_time - make_interval(mins => l.slot_interval_min),
         make_interval(mins => l.slot_interval_min)) AS gs(local_start)
     WHERE l.id = $1 AND l.is_active
       AND NOT (oh.break_start IS NOT NULL
                AND gs.local_start < $2::date + oh.break_end
                AND gs.local_start + make_interval(mins => l.slot_interval_min)
                    > $2::date + oh.break_start)
     ORDER BY gs.local_start`,
    [locationId, localDate],
  );
  return result.rows;
}

// Services and resources

export interface BookableService {
  id: string;
  name: string;
  requires_dp: boolean;
  dp_amount: number | null;
}

export async function getBookableService(
  client: pg.PoolClient,
  serviceId: string,
): Promise<BookableService | null> {
  const result = await client.query<BookableService>(
    `SELECT s.id, s.name, s.requires_dp, s.dp_amount::float8 AS dp_amount
     FROM services s WHERE s.id = $1 AND s.is_active`,
    [serviceId],
  );
  return result.rows[0] ?? null;
}

export interface ResourceRow {
  id: string;
  name: string;
}

/** Active resources of the location, ordered by name (the order holds try them in). */
export async function listActiveResources(
  client: pg.PoolClient,
  locationId: string,
): Promise<ResourceRow[]> {
  const result = await client.query<ResourceRow>(
    `SELECT r.id, r.name FROM resources r
     WHERE r.location_id = $1 AND r.is_active ORDER BY r.name, r.id`,
    [locationId],
  );
  return result.rows;
}

/** Active resources of the location that serve the service. */
export async function listLinkedResources(
  client: pg.PoolClient,
  serviceId: string,
  locationId: string,
): Promise<ResourceRow[]> {
  const result = await client.query<ResourceRow>(
    `SELECT r.id, r.name
     FROM service_resources sr JOIN resources r ON r.id = sr.resource_id
     WHERE sr.service_id = $1 AND r.location_id = $2 AND r.is_active
     ORDER BY r.name, r.id`,
    [serviceId, locationId],
  );
  return result.rows;
}

export interface Candidate extends ResourceRow {
  booked: boolean;
  locked: boolean;
}

/** Q3: candidate resources for a slot with their database state (booked / held by a live hold). */
export async function listCandidates(
  client: pg.PoolClient,
  serviceId: string,
  locationId: string,
  start: string,
  end: string,
  now: string,
): Promise<Candidate[]> {
  const result = await client.query<Candidate>(
    `SELECT r.id, r.name,
       EXISTS (SELECT 1 FROM bookings b WHERE b.resource_id = r.id
               AND b.status IN ('CONFIRMED', 'COMPLETED', 'NO_SHOW')
               AND b.start_time < $4::timestamptz AND b.end_time > $3::timestamptz) AS booked,
       EXISTS (SELECT 1 FROM bookings b WHERE b.resource_id = r.id
               AND b.status = 'PENDING_PAYMENT' AND b.hold_expires_at > $5::timestamptz
               AND b.start_time < $4::timestamptz AND b.end_time > $3::timestamptz) AS locked
     FROM service_resources sr JOIN resources r ON r.id = sr.resource_id
     WHERE sr.service_id = $1 AND r.location_id = $2 AND r.is_active
     ORDER BY r.name, r.id`,
    [serviceId, locationId, start, end, now],
  );
  return result.rows;
}

// Quota

export interface QuotaRead {
  monthly_ticket_quota: number | null;
  ticket_count: number | null;
}

/** Q5: the quota and the count so far; null when the location has no subscription. */
export async function readQuota(
  client: pg.PoolClient,
  locationId: string,
  periodMonth: string,
): Promise<QuotaRead | null> {
  const result = await client.query<QuotaRead>(
    `SELECT p.monthly_ticket_quota, uc.ticket_count
     FROM subscriptions s JOIN plans p ON p.code = s.plan_code
     LEFT JOIN usage_counters uc ON uc.location_id = s.location_id AND uc.period_month = $2::date
     WHERE s.location_id = $1`,
    [locationId, periodMonth],
  );
  return result.rows[0] ?? null;
}

// Bookings

export interface BookingRow {
  id: string;
  tenant_id: string;
  location_id: string;
  service_id: string;
  service_name: string;
  resource_id: string;
  resource_name: string;
  customer_name: string;
  customer_phone: string;
  start_time: Date;
  end_time: Date;
  status: BookingStatus;
  payment_status: PaymentStatus;
  dp_amount: number | null;
  dp_paid: number | null;
  payment_ref: string | null;
  hold_token: string;
  hold_expires_at: Date | null;
  reminder_sent_at: Date | null;
  created_at: Date;
}

const BOOKING_SELECT = `SELECT b.id, b.tenant_id, b.location_id, b.service_id, s.name AS service_name,
       b.resource_id, r.name AS resource_name, b.customer_name, b.customer_phone,
       b.start_time, b.end_time, b.status, b.payment_status,
       b.dp_amount::float8 AS dp_amount, b.dp_paid::float8 AS dp_paid, b.payment_ref,
       b.hold_token, b.hold_expires_at, b.reminder_sent_at, b.created_at
     FROM bookings b JOIN services s ON s.id = b.service_id JOIN resources r ON r.id = b.resource_id`;

export async function selectBookingsByIds(
  client: pg.PoolClient,
  ids: string[],
): Promise<BookingRow[]> {
  if (ids.length === 0) return [];
  const result = await client.query<BookingRow>(
    `${BOOKING_SELECT} WHERE b.id = ANY($1::uuid[]) ORDER BY b.start_time, r.name, b.id`,
    [ids],
  );
  return result.rows;
}

/** The booking row, locked for the transaction; with `phone` only when it belongs to that number. */
export async function lockBooking(
  client: pg.PoolClient,
  id: string,
  phone?: string,
): Promise<BookingRow | null> {
  const result = await client.query<BookingRow>(
    `${BOOKING_SELECT} WHERE b.id = $1 AND ($2::text IS NULL OR b.customer_phone = $2)
     FOR UPDATE OF b`,
    [id, phone ?? null],
  );
  return result.rows[0] ?? null;
}

/** Q7: the callback target by id and payment_ref, locked; `amount_matches` compares with dp_amount. */
export async function lockPaymentTarget(
  client: pg.PoolClient,
  id: string,
  paymentRef: string,
  amount: number,
): Promise<(BookingRow & { amount_matches: boolean | null }) | null> {
  const result = await client.query<BookingRow & { amount_matches: boolean | null }>(
    `${BOOKING_SELECT.replace(
      'FROM bookings b',
      ', (b.dp_amount = $3::numeric) AS amount_matches FROM bookings b',
    )}
     WHERE b.id = $1 AND b.payment_ref = $2
     FOR UPDATE OF b`,
    [id, paymentRef, amount],
  );
  return result.rows[0] ?? null;
}

/** Bookings that occupy a resource in [from, to): live holds and confirmed/finished bookings. */
export async function listOverlappingBookings(
  client: pg.PoolClient,
  locationId: string,
  from: string,
  to: string,
  now: string,
): Promise<BookingRow[]> {
  const result = await client.query<BookingRow>(
    `${BOOKING_SELECT}
     WHERE b.location_id = $1 AND b.start_time < $3::timestamptz AND b.end_time > $2::timestamptz
       AND ((b.status = 'PENDING_PAYMENT' AND b.hold_expires_at > $4::timestamptz)
            OR b.status IN ('CONFIRMED', 'COMPLETED', 'NO_SHOW'))
     ORDER BY b.start_time, r.name, b.id`,
    [locationId, from, to, now],
  );
  return result.rows;
}

/** CONFIRMED bookings that have not ended yet, and holds that are still alive. */
export async function listActiveByPhone(
  client: pg.PoolClient,
  locationId: string,
  phone: string,
  now: string,
): Promise<BookingRow[]> {
  const result = await client.query<BookingRow>(
    `${BOOKING_SELECT}
     WHERE b.location_id = $1 AND b.customer_phone = $2
       AND ((b.status = 'CONFIRMED' AND b.end_time > $3::timestamptz)
            OR (b.status = 'PENDING_PAYMENT' AND b.hold_expires_at > $3::timestamptz))
     ORDER BY b.start_time, b.id`,
    [locationId, phone, now],
  );
  return result.rows;
}

export interface ExpiredHold {
  id: string;
}

/** Q2: expires the stale holds of a slot (status only; payment_status never changes here). */
export async function expireStaleHolds(
  client: pg.PoolClient,
  locationId: string,
  start: string,
  end: string,
  now: string,
): Promise<ExpiredHold[]> {
  const result = await client.query<ExpiredHold>(
    `UPDATE bookings SET status = 'EXPIRED'
     WHERE location_id = $1 AND start_time < $3::timestamptz AND end_time > $2::timestamptz
       AND status = 'PENDING_PAYMENT' AND hold_expires_at <= $4::timestamptz
     RETURNING id`,
    [locationId, start, end, now],
  );
  return result.rows;
}

export interface InsertBooking {
  tenantId: string;
  locationId: string;
  resourceId: string;
  serviceId: string;
  customerName: string;
  customerPhone: string;
  start: string;
  end: string;
  status: 'PENDING_PAYMENT' | 'CONFIRMED';
  holdToken: string;
  holdExpiresAt: string | null;
  dpAmount: number | null;
  paymentStatus: 'UNPAID' | 'NOT_REQUIRED';
  paymentRef: string | null;
}

/** Q4. A concurrent holder of the same slot surfaces as a bookings_active_slot_key violation. */
export async function insertBooking(client: pg.PoolClient, input: InsertBooking): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO bookings
       (tenant_id, location_id, resource_id, service_id, customer_name, customer_phone,
        start_time, end_time, status, hold_token, hold_expires_at, dp_amount, payment_status,
        payment_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10,
             $11::timestamptz, $12::numeric, $13, $14)
     RETURNING id`,
    [
      input.tenantId,
      input.locationId,
      input.resourceId,
      input.serviceId,
      input.customerName,
      input.customerPhone,
      input.start,
      input.end,
      input.status,
      input.holdToken,
      input.holdExpiresAt,
      input.dpAmount,
      input.paymentStatus,
      input.paymentRef,
    ],
  );
  return result.rows[0]!.id;
}

/** Sets status and payment_status of a locked booking; `dpPaid` is only written when given. */
export async function updateBooking(
  client: pg.PoolClient,
  id: string,
  status: BookingStatus,
  paymentStatus: PaymentStatus,
  dpPaid: number | null = null,
): Promise<void> {
  await client.query(
    `UPDATE bookings
     SET status = $2, payment_status = $3, dp_paid = COALESCE($4::numeric, dp_paid)
     WHERE id = $1`,
    [id, status, paymentStatus, dpPaid],
  );
}

// Jobs (spec section 7.2 auto-release, FR-BOOKING-05 reminder)

/** Candidates of the expiry job; SECURITY DEFINER, so it runs without a tenant context. */
export async function dueHolds(
  client: pg.PoolClient,
): Promise<{ tenant_id: string; id: string }[]> {
  const result = await client.query<{ tenant_id: string; id: string }>(
    'SELECT tenant_id, id FROM app_due_booking_holds()',
  );
  return result.rows;
}

export async function dueReminders(
  client: pg.PoolClient,
): Promise<{ tenant_id: string; id: string }[]> {
  const result = await client.query<{ tenant_id: string; id: string }>(
    'SELECT tenant_id, id FROM app_due_booking_reminders()',
  );
  return result.rows;
}

/** Conditional expire: true when this call moved the hold to EXPIRED (exactly-once across replicas). */
export async function expireHoldIfDue(
  client: pg.PoolClient,
  id: string,
  now: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE bookings SET status = 'EXPIRED'
     WHERE id = $1 AND status = 'PENDING_PAYMENT' AND hold_expires_at <= $2::timestamptz
     RETURNING id`,
    [id, now],
  );
  return result.rowCount === 1;
}

/** Conditional reminder mark: true when this call set reminder_sent_at. */
export async function markReminderIfDue(
  client: pg.PoolClient,
  id: string,
  now: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE bookings SET reminder_sent_at = $2::timestamptz
     WHERE id = $1 AND status = 'CONFIRMED' AND reminder_sent_at IS NULL
       AND start_time > $2::timestamptz
       AND start_time <= $2::timestamptz + interval '30 minutes'
     RETURNING id`,
    [id, now],
  );
  return result.rowCount === 1;
}
