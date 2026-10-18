import { randomUUID } from 'node:crypto';

import type { BookingDto, PaymentCallbackResponse } from '@antre/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runExpiryJob } from '../src/booking/jobs.js';
import { slotLockKey, type RedisSlotLock } from '../src/booking/slot-lock.js';
import { signatureHeader } from '../src/payments/signature.js';
import {
  apiRequest,
  createClock,
  createTestApp,
  DP_AMOUNT,
  eventsOfType,
  internalHeaders,
  queryInTenant,
  redisSlotLock,
  setupBookingFixture,
  type BookingFixture,
  type TestApp,
} from './helpers.js';

const MINUTE = 60_000;
const clock = createClock(new Date().toISOString());
let ctx: TestApp;
let lock: RedisSlotLock;
let f: BookingFixture;
let nextSlot = 0;

/** A fresh slot two days ahead (each test uses its own, hours 00:00-22:00 WIB). */
function freshSlot(): string {
  const now = new Date();
  const hour = nextSlot % 23;
  const day = 2 + Math.floor(nextSlot / 23);
  nextSlot += 1;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, hour - 7),
  ).toISOString();
}

beforeAll(async () => {
  lock = await redisSlotLock();
  ctx = await createTestApp({ now: clock.now, slotLock: lock });
  f = await setupBookingFixture(ctx);
});

afterAll(async () => {
  await ctx.close();
  await lock.close();
});

beforeEach(() => {
  clock.set(new Date().toISOString());
  ctx.events.clear();
});

/** Holds a DP slot with the app clock `offsetMs` away from the real time, then restores the clock. */
async function holdDp(offsetMs = 0): Promise<BookingDto> {
  const real = Date.now();
  clock.set(new Date(real + offsetMs).toISOString());
  const response = await apiRequest(
    ctx.app,
    'POST',
    '/internal/v1/bookings/holds',
    internalHeaders(ctx, f.tenant.tenantId),
    {
      location_id: f.locationId,
      service_id: f.dpServiceId,
      slot_start: freshSlot(),
      customer_name: 'Budi',
      customer_phone: '6281111111111',
    },
  );
  clock.set(new Date(real).toISOString());
  if (response.statusCode !== 201) throw new Error(`hold failed: ${response.body}`);
  return response.json<BookingDto>();
}

function payload(booking: BookingDto, overrides: object = {}) {
  return {
    payment_ref: booking.payment_ref,
    tenant_id: f.tenant.tenantId,
    target_id: booking.id,
    amount: DP_AMOUNT,
    status: 'PAID',
    ...overrides,
  };
}

/** Posts a callback signed with the right secret unless told otherwise. */
function callback(body: object | string, headers: Record<string, string> | 'signed' = 'signed') {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/payments/qris/callback',
    headers: {
      'content-type': 'application/json',
      ...(headers === 'signed'
        ? { 'x-antre-signature': signatureHeader(raw, ctx.paymentCallbackSecret) }
        : headers),
    },
    payload: raw,
  });
}

async function rowOf(id: string) {
  const rows = await queryInTenant<{
    status: string;
    payment_status: string;
    dp_paid: number | null;
  }>(
    ctx.pool,
    f.tenant.tenantId,
    'SELECT status, payment_status, dp_paid::float8 AS dp_paid FROM bookings WHERE id = $1',
    [id],
  );
  return rows[0]!;
}

async function usage(): Promise<number> {
  const rows = await queryInTenant<{ total: number }>(
    ctx.pool,
    f.tenant.tenantId,
    'SELECT coalesce(sum(ticket_count), 0)::int AS total FROM usage_counters WHERE location_id = $1',
    [f.locationId],
  );
  return rows[0]!.total;
}

function eventsFor(type: Parameters<typeof eventsOfType>[1], bookingId: string) {
  return eventsOfType(ctx, type).filter(
    (event) => (event.data as { booking_id?: string }).booking_id === bookingId,
  );
}

async function lockHeld(booking: BookingDto): Promise<boolean> {
  const key = slotLockKey(booking.resource_id, new Date(booking.start_time));
  return (await lock.held([key])).size === 1;
}

describe('signature', () => {
  it('rejects a missing, wrong, or mismatching signature without touching the database', async () => {
    const booking = await holdDp();
    const body = JSON.stringify(payload(booking));
    const wrongSecret = signatureHeader(body, 'another-secret-of-at-least-32-characters-x');
    const otherBody = signatureHeader(
      JSON.stringify(payload(booking, { amount: 1 })),
      ctx.paymentCallbackSecret,
    );

    const badHeaders: Record<string, string>[] = [
      {},
      { 'x-antre-signature': wrongSecret },
      { 'x-antre-signature': otherBody },
      { 'x-antre-signature': 'sha256=zz' },
    ];
    for (const headers of badHeaders) {
      const response = await callback(body, headers);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
    }
    expect(await rowOf(booking.id)).toMatchObject({
      status: 'PENDING_PAYMENT',
      payment_status: 'UNPAID',
    });
    expect(await lockHeld(booking)).toBe(true);
    expect(eventsOfType(ctx, 'booking.reservation.confirmed')).toHaveLength(0);
  });

  it('rejects signed bodies that are not valid callbacks with 400', async () => {
    const booking = await holdDp();
    for (const body of [
      '{not json',
      JSON.stringify({ ...payload(booking), extra: 1 }),
      JSON.stringify(payload(booking, { amount: 10_000_000_000 })),
      JSON.stringify(payload(booking, { amount: 0 })),
      JSON.stringify(payload(booking, { tenant_id: 'nope' })),
    ]) {
      const response = await callback(body);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(await rowOf(booking.id)).toMatchObject({ status: 'PENDING_PAYMENT' });
  });

  it('does not touch a booking for a status other than PAID', async () => {
    const booking = await holdDp();
    const response = await callback(payload(booking, { status: 'FAILED' }));
    expect(response.statusCode).toBe(200);
    expect(await rowOf(booking.id)).toMatchObject({
      status: 'PENDING_PAYMENT',
      payment_status: 'UNPAID',
    });
    expect(await lockHeld(booking)).toBe(true);
  });
});

describe('on time', () => {
  it('confirms the booking, counts it once, releases the lock, and ignores a repeat', async () => {
    const booking = await holdDp();
    ctx.events.clear();
    const before = await usage();

    const response = await callback(payload(booking));
    expect(response.statusCode).toBe(200);
    expect(response.json<PaymentCallbackResponse>()).toEqual({
      booking_id: booking.id,
      status: 'CONFIRMED',
      payment_status: 'PAID',
    });
    expect(await rowOf(booking.id)).toEqual({
      status: 'CONFIRMED',
      payment_status: 'PAID',
      dp_paid: DP_AMOUNT,
    });
    expect(await usage()).toBe(before + 1);
    expect(await lockHeld(booking)).toBe(false);
    expect(eventsFor('booking.reservation.confirmed', booking.id)).toHaveLength(1);

    const repeat = await callback(payload(booking));
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json<PaymentCallbackResponse>().status).toBe('CONFIRMED');
    expect(await usage()).toBe(before + 1);
    expect(eventsFor('booking.reservation.confirmed', booking.id)).toHaveLength(1);
  });

  it('counts two parallel callbacks once', async () => {
    const booking = await holdDp();
    ctx.events.clear();
    const before = await usage();

    const responses = await Promise.all([callback(payload(booking)), callback(payload(booking))]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await usage()).toBe(before + 1);
    expect(eventsFor('booking.reservation.confirmed', booking.id)).toHaveLength(1);
  });

  it('cancels with a refund when the amount differs', async () => {
    const booking = await holdDp();
    ctx.events.clear();

    const response = await callback(payload(booking, { amount: DP_AMOUNT - 1 }));
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe('PAYMENT_NOT_APPLICABLE');
    expect(body.error.details).toMatchObject({
      status: 'CANCELLED',
      payment_status: 'REFUND_PENDING',
    });
    expect(await rowOf(booking.id)).toEqual({
      status: 'CANCELLED',
      payment_status: 'REFUND_PENDING',
      dp_paid: DP_AMOUNT - 1,
    });
    expect(await lockHeld(booking)).toBe(false);
    expect(eventsFor('booking.reservation.cancelled', booking.id)).toHaveLength(1);
    expect(eventsFor('booking.reservation.confirmed', booking.id)).toHaveLength(0);
  });
});

describe('too late', () => {
  it('expires with a refund when the callback comes after the hold, before the job', async () => {
    const booking = await holdDp();
    ctx.events.clear();
    clock.set(new Date(Date.now() + 6 * MINUTE).toISOString());

    const response = await callback(payload(booking));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PAYMENT_NOT_APPLICABLE');
    expect(await rowOf(booking.id)).toEqual({
      status: 'EXPIRED',
      payment_status: 'REFUND_PENDING',
      dp_paid: DP_AMOUNT,
    });
    expect(await lockHeld(booking)).toBe(false);
    expect(eventsFor('booking.reservation.expired', booking.id)).toHaveLength(1);

    // The job finds nothing to do for it afterwards.
    await runExpiryJob({
      pool: ctx.pool,
      slotLock: lock,
      events: ctx.events,
      now: () => new Date(),
      log: { warn: () => {}, error: () => {} },
    });
    expect(eventsFor('booking.reservation.expired', booking.id)).toHaveLength(1);
  });

  it('turns a payment after the job into REFUND_PENDING without another event', async () => {
    const booking = await holdDp(-10 * MINUTE);
    ctx.events.clear();
    await runExpiryJob({
      pool: ctx.pool,
      slotLock: lock,
      events: ctx.events,
      now: () => new Date(),
      log: { warn: () => {}, error: () => {} },
    });
    expect(await rowOf(booking.id)).toMatchObject({ status: 'EXPIRED', payment_status: 'UNPAID' });
    expect(eventsFor('booking.reservation.expired', booking.id)).toHaveLength(1);

    const response = await callback(payload(booking));
    expect(response.statusCode).toBe(409);
    expect(await rowOf(booking.id)).toEqual({
      status: 'EXPIRED',
      payment_status: 'REFUND_PENDING',
      dp_paid: DP_AMOUNT,
    });
    expect(eventsFor('booking.reservation.expired', booking.id)).toHaveLength(1);

    const again = await callback(payload(booking));
    expect(again.statusCode).toBe(409);
    expect(eventsFor('booking.reservation.expired', booking.id)).toHaveLength(1);
  });

  it('leaves a booking confirmed before the job ran untouched by the job', async () => {
    // The app clock is ten minutes behind, so the payment is on time for it while the database
    // clock already finds the hold due.
    const booking = await holdDp(-10 * MINUTE);
    clock.set(new Date(Date.now() - 10 * MINUTE).toISOString());
    const response = await callback(payload(booking));
    expect(response.statusCode).toBe(200);
    clock.set(new Date().toISOString());
    ctx.events.clear();

    await runExpiryJob({
      pool: ctx.pool,
      slotLock: lock,
      events: ctx.events,
      now: () => new Date(),
      log: { warn: () => {}, error: () => {} },
    });
    expect(await rowOf(booking.id)).toMatchObject({ status: 'CONFIRMED', payment_status: 'PAID' });
    expect(eventsFor('booking.reservation.expired', booking.id)).toHaveLength(0);
  });
});

describe('other targets', () => {
  it('marks a cancelled unpaid booking REFUND_PENDING, then answers repeats with 409', async () => {
    const booking = await holdDp();
    const cancel = await apiRequest(
      ctx.app,
      'POST',
      `/api/v1/bookings/${booking.id}/actions`,
      f.cashier,
      { action: 'CANCEL' },
    );
    expect(cancel.statusCode).toBe(200);
    ctx.events.clear();

    const first = await callback(payload(booking));
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe('PAYMENT_NOT_APPLICABLE');
    expect(await rowOf(booking.id)).toEqual({
      status: 'CANCELLED',
      payment_status: 'REFUND_PENDING',
      dp_paid: DP_AMOUNT,
    });
    const second = await callback(payload(booking));
    expect(second.statusCode).toBe(409);
    expect(ctx.events.events).toHaveLength(0);
  });

  it('answers 404 PAYMENT_TARGET_NOT_FOUND for an unknown target, reference, or tenant', async () => {
    const booking = await holdDp();
    for (const overrides of [
      { target_id: randomUUID() },
      { payment_ref: 'pay-unknown' },
      { tenant_id: randomUUID() },
    ]) {
      const response = await callback(payload(booking, overrides));
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('PAYMENT_TARGET_NOT_FOUND');
    }
    expect(await rowOf(booking.id)).toMatchObject({ status: 'PENDING_PAYMENT' });
  });
});
