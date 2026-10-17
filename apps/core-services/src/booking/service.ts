// Booking use cases (spec sections 6.3, 7.2, 7.3, 7.4; FR-BOOKING-*). Each use case runs inside one
// tenant transaction and returns `{ result, events, releases }`; `runBooking` publishes the events
// and releases the slot locks after the commit.
import { randomBytes, randomUUID } from 'node:crypto';

import { createEvent, type EventEnvelope } from '@antre/event-contracts';
import {
  BOOKING_TRANSITIONS,
  nextBookingStatus,
  paymentStatusAfterCancel,
  type ActiveBookingsResponse,
  type AvailableSlotsResponse,
  type BookingCalendarResponse,
  type BookingDto,
  type PaymentCallback,
  type PaymentCallbackResponse,
  type SlotState,
  type STAFF_BOOKING_ACTIONS,
} from '@antre/shared-types';
import type pg from 'pg';

import type { AppDeps } from '../auth/plugin.js';
import { incrementUsageUnconditional, quotaThresholdEvents } from '../billing/quota.js';
import { AppError, uniqueViolationConstraint } from '../errors.js';
import { publishAll } from '../events/publisher.js';
import { getLocationContext, type LocationContext } from '../queue/queries.js';
import {
  expireStaleHolds,
  getBookableService,
  getSlotInterval,
  insertBooking,
  listActiveByPhone,
  listActiveResources,
  listCandidates,
  listLinkedResources,
  listOverlappingBookings,
  listSlots,
  localDateOf,
  lockBooking,
  lockPaymentTarget,
  readQuota,
  selectBookingsByIds,
  updateBooking,
  type BookingRow,
  type ResourceRow,
  type SlotRow,
} from './queries.js';
import { HOLD_TTL_MS, SlotLockUnavailableError, slotLockKey, type SlotLock } from './slot-lock.js';

export type StaffBookingAction = (typeof STAFF_BOOKING_ACTIONS)[number];

export interface BookingLogger {
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface BookingEnv {
  tenantId: string;
  now: Date;
  slotLock: SlotLock;
  log: BookingLogger;
}

export interface LockRelease {
  key: string;
  token: string;
}

export interface BookingOutcome<T> {
  result: T;
  events: EventEnvelope[];
  /** Locks to release after the commit. */
  releases: LockRelease[];
}

/** Locks taken so far by a running use case; released when the use case fails for any reason. */
export interface LockTracker {
  acquired: LockRelease[];
}

type Runner<T> = (
  work: (client: pg.PoolClient) => Promise<BookingOutcome<T>>,
) => Promise<BookingOutcome<T>>;

async function releaseAll(slotLock: SlotLock, releases: LockRelease[], log: BookingLogger) {
  for (const { key, token } of releases) {
    try {
      await slotLock.release(key, token);
    } catch (error) {
      // The TTL clears the key within 5 minutes.
      log.warn({ err: error, key }, 'slot lock release failed');
    }
  }
}

/**
 * Runs a use case in a transaction (`run`), then releases locks and publishes events after the
 * commit. When the use case fails (including a failed COMMIT) the locks it took are released first.
 */
export async function runBooking<T>(
  deps: AppDeps,
  log: BookingLogger,
  run: Runner<T>,
  work: (client: pg.PoolClient, tracker: LockTracker) => Promise<BookingOutcome<T>>,
): Promise<T> {
  const tracker: LockTracker = { acquired: [] };
  let outcome: BookingOutcome<T>;
  try {
    outcome = await run((client) => work(client, tracker));
  } catch (error) {
    await releaseAll(deps.slotLock, tracker.acquired, log);
    // Final guarantee of one active booking per resource and slot (FR-BOOKING-02).
    if (uniqueViolationConstraint(error) === 'bookings_active_slot_key') {
      throw new AppError('SLOT_TAKEN', 'Slot ini sudah dipesan.');
    }
    throw error;
  }
  await releaseAll(deps.slotLock, outcome.releases, log);
  await publishAll(deps.events, outcome.events, log);
  return outcome.result;
}

// Helpers

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Reservasi tidak ditemukan.');
}

async function openContext(
  client: pg.PoolClient,
  env: BookingEnv,
  locationId: string,
): Promise<LocationContext> {
  const context = await getLocationContext(client, locationId, env.now.toISOString());
  if (context === null) throw new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.');
  if (context.service_mode === 'WALK_IN') {
    throw new AppError('MODE_DISABLED', 'Reservasi tidak tersedia pada mode antrean langsung.');
  }
  return context;
}

export function toBookingDto(row: BookingRow): BookingDto {
  return {
    id: row.id,
    location_id: row.location_id,
    service_id: row.service_id,
    service_name: row.service_name,
    resource_id: row.resource_id,
    resource_name: row.resource_name,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    start_time: row.start_time.toISOString(),
    end_time: row.end_time.toISOString(),
    status: row.status,
    payment_status: row.payment_status,
    dp_amount: row.dp_amount,
    dp_paid: row.dp_paid,
    payment_ref: row.payment_ref,
    hold_expires_at: row.hold_expires_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

function lockOf(row: BookingRow): LockRelease {
  return { key: slotLockKey(row.resource_id, row.start_time), token: row.hold_token };
}

export interface BookingScope {
  tenant: { id: string; name: string };
  location: { id: string; code: string };
}

export function bookingScope(tenantId: string, context: LocationContext): BookingScope {
  return {
    tenant: { id: tenantId, name: context.tenant_name },
    location: { id: context.id, code: context.code },
  };
}

export type BookingEventKind =
  'held' | 'confirmed' | 'expired' | 'reminder_due' | 'cancelled' | 'completed' | 'no_show';

/** The `booking.reservation.*` event of a booking row in the state the row now has. */
export function bookingEvent(
  kind: BookingEventKind,
  scope: BookingScope,
  row: BookingRow,
  now: Date,
): EventEnvelope {
  const ref = {
    booking_id: row.id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    service_name: row.service_name,
    resource_name: row.resource_name,
    start_time: row.start_time.toISOString(),
    end_time: row.end_time.toISOString(),
  };
  const opts = { now };
  switch (kind) {
    case 'held':
      return createEvent(
        'booking.reservation.held',
        {
          ...scope,
          data: {
            ...ref,
            status: 'PENDING_PAYMENT',
            payment_status: 'UNPAID',
            dp_amount: row.dp_amount!,
            payment_ref: row.payment_ref!,
            hold_expires_at: row.hold_expires_at!.toISOString(),
          },
        },
        opts,
      );
    case 'confirmed':
      return createEvent(
        'booking.reservation.confirmed',
        {
          ...scope,
          data: {
            ...ref,
            status: 'CONFIRMED',
            payment_status: row.payment_status === 'PAID' ? 'PAID' : 'NOT_REQUIRED',
            dp_amount: row.dp_amount,
          },
        },
        opts,
      );
    case 'expired':
      return createEvent(
        'booking.reservation.expired',
        { ...scope, data: { ...ref, status: 'EXPIRED', payment_status: row.payment_status } },
        opts,
      );
    case 'reminder_due':
      return createEvent(
        'booking.reservation.reminder_due',
        { ...scope, data: { ...ref, status: 'CONFIRMED' } },
        opts,
      );
    case 'cancelled':
      return createEvent(
        'booking.reservation.cancelled',
        { ...scope, data: { ...ref, status: 'CANCELLED', payment_status: row.payment_status } },
        opts,
      );
    case 'completed':
      return createEvent(
        'booking.reservation.completed',
        { ...scope, data: { ...ref, status: 'COMPLETED' } },
        opts,
      );
    case 'no_show':
      return createEvent(
        'booking.reservation.no_show',
        { ...scope, data: { ...ref, status: 'NO_SHOW' } },
        opts,
      );
  }
}

async function loadRow(client: pg.PoolClient, id: string): Promise<BookingRow> {
  const row = (await selectBookingsByIds(client, [id]))[0];
  if (row === undefined) throw notFound();
  return row;
}

// Slot availability

interface Cell {
  state: SlotState;
  booking: BookingRow | null;
}

const cellKey = (slot: SlotRow, resourceId: string): string =>
  `${resourceId}:${slot.start_time.toISOString()}`;

function overlaps(booking: BookingRow, slot: SlotRow): boolean {
  return booking.start_time < slot.end_time && booking.end_time > slot.start_time;
}

/**
 * State of every (slot, resource) cell: BOOKED / LOCKED from the database first, then LOCKED for
 * cells that only a Redis lock holds. A Redis failure shows the database view alone (D1).
 */
async function resolveCells(
  env: BookingEnv,
  slots: SlotRow[],
  resources: ResourceRow[],
  bookings: BookingRow[],
): Promise<Map<string, Cell>> {
  const cells = new Map<string, Cell>();
  const freeKeys: string[] = [];
  for (const slot of slots) {
    for (const resource of resources) {
      const here = bookings.filter((b) => b.resource_id === resource.id && overlaps(b, slot));
      const booked = here.find((b) => b.status !== 'PENDING_PAYMENT');
      const pending = here.find((b) => b.status === 'PENDING_PAYMENT');
      const key = cellKey(slot, resource.id);
      if (booked !== undefined) cells.set(key, { state: 'BOOKED', booking: booked });
      else if (pending !== undefined) cells.set(key, { state: 'LOCKED', booking: pending });
      else {
        cells.set(key, { state: 'AVAILABLE', booking: null });
        freeKeys.push(slotLockKey(resource.id, slot.start_time));
      }
    }
  }
  if (freeKeys.length === 0) return cells;

  try {
    const held = await env.slotLock.held(freeKeys);
    for (const slot of slots) {
      for (const resource of resources) {
        const cell = cells.get(cellKey(slot, resource.id))!;
        if (cell.state === 'AVAILABLE' && held.has(slotLockKey(resource.id, slot.start_time))) {
          cell.state = 'LOCKED';
        }
      }
    }
  } catch (error) {
    if (!(error instanceof SlotLockUnavailableError)) throw error;
    env.log.warn({ err: error }, 'slot lock read failed; showing the database view');
  }
  return cells;
}

async function dayView(
  client: pg.PoolClient,
  env: BookingEnv,
  locationId: string,
  date: string,
): Promise<{ intervalMin: number; slots: SlotRow[]; bookings: BookingRow[] }> {
  const slots = await listSlots(client, locationId, date);
  const intervalMin = (await getSlotInterval(client, locationId)) ?? 0;
  if (slots.length === 0) return { intervalMin, slots, bookings: [] };
  const bookings = await listOverlappingBookings(
    client,
    locationId,
    slots[0]!.start_time.toISOString(),
    slots[slots.length - 1]!.end_time.toISOString(),
    env.now.toISOString(),
  );
  return { intervalMin, slots, bookings };
}

/** Staff calendar of one local day: every active resource of the location, past slots included. */
export async function listCalendar(
  client: pg.PoolClient,
  env: BookingEnv,
  locationId: string,
  date: string,
): Promise<BookingCalendarResponse> {
  await openContext(client, env, locationId);
  const resources = await listActiveResources(client, locationId);
  const { intervalMin, slots, bookings } = await dayView(client, env, locationId, date);
  const cells = await resolveCells(env, slots, resources, bookings);
  return {
    date,
    slot_interval_min: intervalMin,
    slots: slots.map((slot) => ({
      start_time: slot.start_time.toISOString(),
      end_time: slot.end_time.toISOString(),
      resources: resources.map((resource) => {
        const cell = cells.get(cellKey(slot, resource.id))!;
        return {
          resource_id: resource.id,
          resource_name: resource.name,
          state: cell.state,
          booking: cell.booking === null ? null : toBookingDto(cell.booking),
        };
      }),
    })),
  };
}

/** Slots of one local day that still have a free resource for the service (WhatsApp menu). */
export async function listAvailableSlots(
  client: pg.PoolClient,
  env: BookingEnv,
  locationId: string,
  serviceId: string,
  date: string,
): Promise<AvailableSlotsResponse> {
  await openContext(client, env, locationId);
  const service = await getBookableService(client, serviceId);
  if (service === null) throw new AppError('NOT_FOUND', 'Layanan tidak ditemukan.');

  const resources = await listLinkedResources(client, serviceId, locationId);
  const view = await dayView(client, env, locationId, date);
  const upcoming = view.slots.filter((slot) => slot.start_time > env.now);
  const cells = await resolveCells(env, upcoming, resources, view.bookings);
  return {
    date,
    slot_interval_min: view.intervalMin,
    slots: upcoming
      .filter((slot) =>
        resources.some((resource) => cells.get(cellKey(slot, resource.id))!.state === 'AVAILABLE'),
      )
      .map((slot) => ({
        start_time: slot.start_time.toISOString(),
        end_time: slot.end_time.toISOString(),
      })),
  };
}

// Hold

export interface CreateHoldInput {
  locationId: string;
  serviceId: string;
  slotStart: string;
  customerName: string;
  customerPhone: string;
}

/**
 * Holds a slot (spec section 7.2): database context first, then one `SET NX` per free candidate
 * resource, then the INSERT. Redis is a fast pre-check; the unique index is the final guarantee.
 */
export async function createHold(
  client: pg.PoolClient,
  env: BookingEnv,
  tracker: LockTracker,
  input: CreateHoldInput,
): Promise<BookingOutcome<BookingDto>> {
  const now = env.now.toISOString();
  const context = await openContext(client, env, input.locationId);
  if (!context.is_active) throw new AppError('LOCATION_CLOSED', 'Lokasi sedang tutup.');
  const service = await getBookableService(client, input.serviceId);
  if (service === null) throw new AppError('NOT_FOUND', 'Layanan tidak ditemukan.');

  // The start must be exactly one slot of the grid and lie in the future.
  const start = new Date(input.slotStart);
  const localDate = await localDateOf(client, context.id, start.toISOString());
  const slots = localDate === null ? [] : await listSlots(client, context.id, localDate);
  const slot = slots.find((candidate) => candidate.start_time.getTime() === start.getTime());
  if (slot === undefined || start <= env.now) {
    throw new AppError('VALIDATION_ERROR', 'Slot tidak tersedia atau tidak sesuai jadwal.');
  }
  const startIso = slot.start_time.toISOString();
  const endIso = slot.end_time.toISOString();
  const scope = bookingScope(env.tenantId, context);
  const events: EventEnvelope[] = [];

  // Holds of this slot whose time is up are expired first, so they never block the new one.
  const stale = await expireStaleHolds(client, context.id, startIso, endIso, now);
  for (const row of await selectBookingsByIds(
    client,
    stale.map((hold) => hold.id),
  )) {
    events.push(bookingEvent('expired', scope, row, env.now));
    await releaseAll(env.slotLock, [lockOf(row)], env.log);
  }

  const quota = await readQuota(client, context.id, context.period_month);
  if (
    quota !== null &&
    quota.monthly_ticket_quota !== null &&
    (quota.ticket_count ?? 0) >= quota.monthly_ticket_quota
  ) {
    throw new AppError('QUOTA_EXCEEDED', 'Kuota bulanan lokasi ini sudah habis.');
  }

  const candidates = await listCandidates(client, service.id, context.id, startIso, endIso, now);
  const free = candidates.filter((candidate) => !candidate.booked && !candidate.locked);
  if (free.length === 0) {
    if (candidates.some((candidate) => candidate.locked)) {
      throw new AppError('SLOT_LOCKED', 'Slot ini sedang ditahan oleh pelanggan lain.');
    }
    throw new AppError('SLOT_TAKEN', 'Slot ini sudah dipesan.');
  }

  const holdToken = randomUUID();
  let chosen: ResourceRow | null = null;
  for (const candidate of free) {
    const key = slotLockKey(candidate.id, slot.start_time);
    try {
      if (await env.slotLock.acquire(key, holdToken, HOLD_TTL_MS)) {
        tracker.acquired.push({ key, token: holdToken });
        chosen = candidate;
        break;
      }
    } catch (error) {
      if (!(error instanceof SlotLockUnavailableError)) throw error;
      // Redis is down: continue without a lock; the unique index decides (D1).
      env.log.warn({ err: error, key }, 'slot lock unavailable; falling back to the database');
      chosen = candidate;
      break;
    }
  }
  if (chosen === null) {
    throw new AppError('SLOT_LOCKED', 'Slot ini sedang ditahan oleh pelanggan lain.');
  }

  const needsDp = service.requires_dp;
  const id = await insertBooking(client, {
    tenantId: env.tenantId,
    locationId: context.id,
    resourceId: chosen.id,
    serviceId: service.id,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    start: startIso,
    end: endIso,
    status: needsDp ? 'PENDING_PAYMENT' : 'CONFIRMED',
    holdToken,
    holdExpiresAt: needsDp ? new Date(env.now.getTime() + HOLD_TTL_MS).toISOString() : null,
    dpAmount: needsDp ? service.dp_amount : null,
    paymentStatus: needsDp ? 'UNPAID' : 'NOT_REQUIRED',
    paymentRef: needsDp ? `pay-${randomBytes(12).toString('hex')}` : null,
  });
  const row = await loadRow(client, id);

  if (needsDp) {
    // The lock stays until payment, cancellation, or expiry.
    events.push(bookingEvent('held', scope, row, env.now));
    return { result: toBookingDto(row), events, releases: [] };
  }

  const usage = await incrementUsageUnconditional(
    client,
    env.tenantId,
    context.id,
    context.period_month,
  );
  events.push(
    bookingEvent('confirmed', scope, row, env.now),
    ...(await quotaThresholdEvents(client, {
      scope,
      adminWaPhone: context.admin_wa_phone,
      locationId: context.id,
      periodMonth: context.period_month,
      quota: usage,
      now: env.now,
    })),
  );
  return { result: toBookingDto(row), events, releases: [lockOf(row)] };
}

// Staff and customer actions

/** CANCEL on a locked row: only before the start; a PAID booking moves to REFUND_PENDING. */
async function cancelRow(
  client: pg.PoolClient,
  env: BookingEnv,
  row: BookingRow,
): Promise<BookingOutcome<BookingDto>> {
  if (
    nextBookingStatus(row.status, 'CANCEL') === null ||
    env.now.getTime() >= row.start_time.getTime()
  ) {
    throw new AppError(
      'INVALID_TRANSITION',
      'Reservasi hanya dapat dibatalkan sebelum waktu mulai.',
    );
  }
  await updateBooking(
    client,
    row.id,
    BOOKING_TRANSITIONS.CANCEL.to,
    paymentStatusAfterCancel(row.payment_status),
  );
  const updated = await loadRow(client, row.id);
  const context = (await getLocationContext(client, row.location_id, env.now.toISOString()))!;
  return {
    result: toBookingDto(updated),
    events: [bookingEvent('cancelled', bookingScope(env.tenantId, context), updated, env.now)],
    releases: row.status === 'PENDING_PAYMENT' ? [lockOf(row)] : [],
  };
}

export async function applyStaffAction(
  client: pg.PoolClient,
  env: BookingEnv,
  id: string,
  action: StaffBookingAction,
): Promise<BookingOutcome<BookingDto>> {
  const row = await lockBooking(client, id);
  if (row === null) throw notFound();
  if (action === 'CANCEL') return cancelRow(client, env, row);

  const target = nextBookingStatus(row.status, action);
  const started = env.now.getTime() >= row.start_time.getTime();
  if (target === null || (action === 'NO_SHOW' && !started)) {
    throw new AppError(
      'INVALID_TRANSITION',
      'Aksi tidak diizinkan pada status reservasi saat ini.',
    );
  }
  await updateBooking(client, row.id, target, row.payment_status);
  const updated = await loadRow(client, row.id);
  const context = (await getLocationContext(client, row.location_id, env.now.toISOString()))!;
  const kind = action === 'COMPLETE' ? 'completed' : 'no_show';
  return {
    result: toBookingDto(updated),
    events: [bookingEvent(kind, bookingScope(env.tenantId, context), updated, env.now)],
    releases: [],
  };
}

/** WhatsApp BATAL: the booking must belong to `customerPhone`. */
export async function cancelByCustomer(
  client: pg.PoolClient,
  env: BookingEnv,
  id: string,
  customerPhone: string,
): Promise<BookingOutcome<BookingDto>> {
  const row = await lockBooking(client, id, customerPhone);
  if (row === null) throw notFound();
  return cancelRow(client, env, row);
}

/** WhatsApp STATUS: confirmed bookings not yet ended and live holds of a phone at the location. */
export async function findActiveBookings(
  client: pg.PoolClient,
  env: BookingEnv,
  locationId: string,
  customerPhone: string,
): Promise<ActiveBookingsResponse> {
  await openContext(client, env, locationId);
  const rows = await listActiveByPhone(client, locationId, customerPhone, env.now.toISOString());
  return { bookings: rows.map(toBookingDto) };
}

// Payment callback (spec section 7.4)

export interface PaymentCallbackResult {
  body: PaymentCallbackResponse;
  /** Set when the callback is answered 409 PAYMENT_NOT_APPLICABLE; the changes are committed anyway. */
  conflict: string | null;
}

function callbackBody(row: BookingRow): PaymentCallbackResponse {
  return { booking_id: row.id, status: row.status, payment_status: row.payment_status };
}

/** The decision table of section 7.4; the booking row is locked, so it is safe against the jobs. */
export async function handlePaymentCallback(
  client: pg.PoolClient,
  env: BookingEnv,
  payload: PaymentCallback,
): Promise<BookingOutcome<PaymentCallbackResult>> {
  const target = await lockPaymentTarget(
    client,
    payload.target_id,
    payload.payment_ref,
    payload.amount,
  );
  if (target === null) {
    throw new AppError('PAYMENT_TARGET_NOT_FOUND', 'Tujuan pembayaran tidak ditemukan.');
  }
  const outcome = (
    row: BookingRow,
    conflict: string | null,
    events: EventEnvelope[] = [],
    releases: LockRelease[] = [],
  ): BookingOutcome<PaymentCallbackResult> => ({
    result: { body: callbackBody(row), conflict },
    events,
    releases,
  });

  // A repeated callback changes nothing (idempotent per payment_ref).
  if (target.payment_status === 'PAID') return outcome(target, null);
  if (target.payment_status === 'REFUND_PENDING') {
    return outcome(target, 'Pembayaran ini sudah ditandai untuk pengembalian dana.');
  }

  const nowIso = env.now.toISOString();
  const context = (await getLocationContext(client, target.location_id, nowIso))!;
  const scope = bookingScope(env.tenantId, context);
  const release = [lockOf(target)];

  if (target.status !== 'PENDING_PAYMENT') {
    // EXPIRED or CANCELLED and still UNPAID: the money arrived too late and must be refunded.
    if (target.payment_status === 'UNPAID') {
      await updateBooking(client, target.id, target.status, 'REFUND_PENDING', payload.amount);
      return outcome(
        await loadRow(client, target.id),
        'Reservasi sudah tidak berlaku; dana akan dikembalikan.',
      );
    }
    return outcome(target, 'Pembayaran tidak dapat diterapkan pada reservasi ini.');
  }

  const late = env.now.getTime() >= (target.hold_expires_at?.getTime() ?? 0);
  if (late) {
    await updateBooking(client, target.id, 'EXPIRED', 'REFUND_PENDING', payload.amount);
    const row = await loadRow(client, target.id);
    return outcome(
      row,
      'Batas waktu pembayaran terlewati; dana akan dikembalikan.',
      [bookingEvent('expired', scope, row, env.now)],
      release,
    );
  }
  if (target.amount_matches !== true) {
    // Section 7.4 leaves this open (D5): the booking is cancelled and the money refunded.
    await updateBooking(client, target.id, 'CANCELLED', 'REFUND_PENDING', payload.amount);
    const row = await loadRow(client, target.id);
    return outcome(
      row,
      'Nominal pembayaran tidak sesuai; dana akan dikembalikan.',
      [bookingEvent('cancelled', scope, row, env.now)],
      release,
    );
  }

  await updateBooking(client, target.id, 'CONFIRMED', 'PAID', payload.amount);
  const row = await loadRow(client, target.id);
  const usage = await incrementUsageUnconditional(
    client,
    env.tenantId,
    context.id,
    context.period_month,
  );
  const events = [
    bookingEvent('confirmed', scope, row, env.now),
    ...(await quotaThresholdEvents(client, {
      scope,
      adminWaPhone: context.admin_wa_phone,
      locationId: context.id,
      periodMonth: context.period_month,
      quota: usage,
      now: env.now,
    })),
  ];
  return outcome(row, null, events, release);
}
