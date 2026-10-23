import type {
  ActiveBookingsResponse,
  AvailableSlotsResponse,
  BookingCalendarResponse,
  BookingDto,
} from '@antre/shared-types';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runExpiryJob, runReminderJob, type BookingJobDeps } from '../src/booking/jobs.js';
import { slotLockKey, type RedisSlotLock } from '../src/booking/slot-lock.js';
import {
  apiRequest,
  bearer,
  createClock,
  createTestApp,
  DEFAULT_CLOCK_ISO,
  DP_AMOUNT,
  eventsOfType,
  internalHeaders,
  queryInTenant,
  redisSlotLock,
  setupBookingFixture,
  type BookingFixture,
  type TestApp,
} from './helpers.js';

const clock = createClock(DEFAULT_CLOCK_ISO);
let ctx: TestApp;
let lock: RedisSlotLock;
let f: BookingFixture;

/** The slot starting at `hour`:00 Asia/Jakarta (UTC+7) on 2026-10-20 (the clock is on the 19th). */
const slot = (hour: number, day = 20): string =>
  new Date(Date.UTC(2026, 9, day, hour - 7)).toISOString();

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
  clock.set(DEFAULT_CLOCK_ISO);
  ctx.events.clear();
});

function hold(
  fixture: BookingFixture,
  serviceId: string,
  slotStart: string,
  phone = '6281111111111',
  extra: object = {},
) {
  return apiRequest(
    ctx.app,
    'POST',
    '/internal/v1/bookings/holds',
    internalHeaders(ctx, fixture.tenant.tenantId),
    {
      location_id: fixture.locationId,
      service_id: serviceId,
      slot_start: slotStart,
      customer_name: 'Budi',
      customer_phone: phone,
      ...extra,
    },
  );
}

function availableSlots(fixture: BookingFixture, serviceId: string, date: string) {
  return apiRequest(
    ctx.app,
    'GET',
    `/internal/v1/bookings/available-slots?location_id=${fixture.locationId}&service_id=${serviceId}&date=${date}`,
    internalHeaders(ctx, fixture.tenant.tenantId),
  );
}

function calendar(fixture: BookingFixture, date: string, headers = fixture.cashier) {
  return apiRequest(
    ctx.app,
    'GET',
    `/api/v1/bookings?location_id=${fixture.locationId}&date=${date}`,
    headers,
  );
}

function action(fixture: BookingFixture, id: string, act: string, headers = fixture.cashier) {
  return apiRequest(ctx.app, 'POST', `/api/v1/bookings/${id}/actions`, headers, { action: act });
}

function eventsFor(type: Parameters<typeof eventsOfType>[1], bookingId: string) {
  return eventsOfType(ctx, type).filter(
    (event) => (event.data as { booking_id?: string }).booking_id === bookingId,
  );
}

async function setBookingRow(fixture: BookingFixture, sql: string, params: unknown[]) {
  await queryInTenant(ctx.pool, fixture.tenant.tenantId, sql, params);
}

describe('available slots', () => {
  it('lists the grid of the day in UTC with the interval', async () => {
    const response = await availableSlots(f, f.dpServiceId, '2026-10-20');
    expect(response.statusCode).toBe(200);
    const body = response.json<AvailableSlotsResponse>();
    expect(body.date).toBe('2026-10-20');
    expect(body.slot_interval_min).toBe(60);
    expect(body.slots).toHaveLength(23);
    expect(body.slots[0]).toEqual({
      start_time: '2026-10-19T17:00:00.000Z',
      end_time: '2026-10-19T18:00:00.000Z',
    });
  });

  it('does not offer slots that already started', async () => {
    const body = (
      await availableSlots(f, f.dpServiceId, '2026-10-19')
    ).json<AvailableSlotsResponse>();
    // The clock is 10:00 WIB: the first offered slot is 11:00 WIB.
    expect(body.slots[0]!.start_time).toBe(slot(11, 19));
    expect(body.slots).toHaveLength(12);
  });

  it('skips the break and follows the location time zone', async () => {
    const g = await setupBookingFixture(ctx);
    const hours = await apiRequest(
      ctx.app,
      'PUT',
      `/api/v1/catalog/locations/${g.locationId}/operating-hours`,
      g.owner,
      {
        slot_interval_min: 60,
        days: Array.from({ length: 7 }, (_, day_of_week) => ({
          day_of_week,
          open_time: '08:00',
          close_time: '17:00',
          break_start: '12:00',
          break_end: '13:00',
        })),
      },
    );
    expect(hours.statusCode).toBe(200);
    const jakarta = (
      await availableSlots(g, g.dpServiceId, '2026-10-20')
    ).json<AvailableSlotsResponse>();
    expect(jakarta.slots).toHaveLength(8);
    expect(jakarta.slots.map((s) => s.start_time)).not.toContain(slot(12));

    const patched = await apiRequest(
      ctx.app,
      'PATCH',
      `/api/v1/locations/${g.locationId}`,
      g.owner,
      {
        timezone: 'Asia/Makassar',
      },
    );
    expect(patched.statusCode).toBe(200);
    const makassar = (
      await availableSlots(g, g.dpServiceId, '2026-10-20')
    ).json<AvailableSlotsResponse>();
    // 08:00 WITA is 00:00Z.
    expect(makassar.slots[0]!.start_time).toBe('2026-10-20T00:00:00.000Z');
  });

  it('hides slots that are held or booked on every resource', async () => {
    const held = slot(20);
    const booked = slot(21);
    expect((await hold(f, f.dpServiceId, held, '6281000000001')).statusCode).toBe(201);
    let starts = (await availableSlots(f, f.dpServiceId, '2026-10-20'))
      .json<AvailableSlotsResponse>()
      .slots.map((s) => s.start_time);
    expect(starts).toContain(held);

    expect((await hold(f, f.dpServiceId, held, '6281000000002')).statusCode).toBe(201);
    expect((await hold(f, f.freeServiceId, booked, '6281000000003')).statusCode).toBe(201);
    expect((await hold(f, f.freeServiceId, booked, '6281000000004')).statusCode).toBe(201);
    starts = (await availableSlots(f, f.dpServiceId, '2026-10-20'))
      .json<AvailableSlotsResponse>()
      .slots.map((s) => s.start_time);
    expect(starts).not.toContain(held);
    expect(starts).not.toContain(booked);
  });

  it('rejects an unknown service and a bad query', async () => {
    expect((await availableSlots(f, randomUUID(), '2026-10-20')).statusCode).toBe(404);
    expect((await availableSlots(f, f.dpServiceId, 'nope')).statusCode).toBe(400);
  });
});

describe('create hold', () => {
  it('holds a DP slot: resource by name, PENDING_PAYMENT, 5 minute hold, lock in Redis', async () => {
    const start = slot(9);
    const response = await hold(f, f.dpServiceId, start);
    expect(response.statusCode).toBe(201);
    const booking = response.json<BookingDto>();
    expect(booking).toMatchObject({
      status: 'PENDING_PAYMENT',
      payment_status: 'UNPAID',
      dp_amount: DP_AMOUNT,
      dp_paid: null,
      resource_id: f.resourceIds[0],
      resource_name: 'Ruang A',
      start_time: start,
      hold_expires_at: new Date(clock.now().getTime() + 300_000).toISOString(),
    });
    expect(booking.payment_ref).toMatch(/^pay-[0-9a-f]{24}$/);
    expect((await lock.held([slotLockKey(f.resourceIds[0], new Date(start))])).size).toBe(1);

    const events = eventsFor('booking.reservation.held', booking.id);
    expect(events).toHaveLength(1);

    // The second customer gets the second resource; the third finds the slot held.
    const second = await hold(f, f.dpServiceId, start, '6281111111112');
    expect(second.json<BookingDto>().resource_name).toBe('Ruang B');
    const third = await hold(f, f.dpServiceId, start, '6281111111113');
    expect(third.statusCode).toBe(409);
    expect(third.json().error.code).toBe('SLOT_LOCKED');
  });

  it('confirms a slot without DP at once and releases the lock', async () => {
    const start = slot(10);
    const response = await hold(f, f.freeServiceId, start);
    expect(response.statusCode).toBe(201);
    const booking = response.json<BookingDto>();
    expect(booking).toMatchObject({
      status: 'CONFIRMED',
      payment_status: 'NOT_REQUIRED',
      dp_amount: null,
      payment_ref: null,
      hold_expires_at: null,
    });
    expect((await lock.held([slotLockKey(booking.resource_id, new Date(start))])).size).toBe(0);
    expect(eventsFor('booking.reservation.confirmed', booking.id)).toHaveLength(1);

    await hold(f, f.freeServiceId, start, '6281111111112');
    const third = await hold(f, f.freeServiceId, start, '6281111111113');
    expect(third.statusCode).toBe(409);
    expect(third.json().error.code).toBe('SLOT_TAKEN');
  });

  it('uses the second resource when the first is locked in Redis, and SLOT_LOCKED when both are', async () => {
    const start = new Date(slot(11));
    expect(await lock.acquire(slotLockKey(f.resourceIds[0], start), 'other-token', 60_000)).toBe(
      true,
    );
    const response = await hold(f, f.dpServiceId, start.toISOString());
    expect(response.statusCode).toBe(201);
    expect(response.json<BookingDto>().resource_name).toBe('Ruang B');

    const start2 = new Date(slot(12));
    for (const resourceId of f.resourceIds) {
      await lock.acquire(slotLockKey(resourceId, start2), 'other-token', 60_000);
    }
    const blocked = await hold(f, f.dpServiceId, start2.toISOString());
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('SLOT_LOCKED');
    for (const resourceId of f.resourceIds) {
      await lock.release(slotLockKey(resourceId, start2), 'other-token');
    }
  });

  it('rejects resource_id, unknown keys, off-grid and past slots', async () => {
    expect(
      (await hold(f, f.dpServiceId, slot(16), '6281111111111', { resource_id: f.resourceIds[0] }))
        .statusCode,
    ).toBe(400);
    expect((await hold(f, f.dpServiceId, '2026-10-20T09:30:00Z')).statusCode).toBe(400);
    expect((await hold(f, f.dpServiceId, slot(9, 19))).statusCode).toBe(400);
    expect((await hold(f, f.dpServiceId, slot(17), '0812')).statusCode).toBe(400);
    expect((await hold(f, randomUUID(), slot(17))).statusCode).toBe(404);
  });

  it('answers MODE_DISABLED for slots and holds when the tenant is walk-in only', async () => {
    const g = await setupBookingFixture(ctx);
    const patched = await apiRequest(ctx.app, 'PATCH', '/api/v1/tenants/me/settings', g.owner, {
      service_mode: 'WALK_IN',
    });
    expect(patched.statusCode).toBe(200);
    for (const response of [
      await hold(g, g.dpServiceId, slot(9)),
      await availableSlots(g, g.dpServiceId, '2026-10-20'),
      await calendar(g, '2026-10-20', g.owner),
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('MODE_DISABLED');
    }
  });

  it('refuses a hold with 402 when the monthly quota is used up, and counts CONFIRMED against it', async () => {
    const g = await setupBookingFixture(ctx);
    const setCount = (count: number) =>
      setBookingRow(
        g,
        `INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
         VALUES ($1, $2, '2026-10-01', $3)
         ON CONFLICT (location_id, period_month) DO UPDATE SET ticket_count = $3`,
        [g.tenant.tenantId, g.locationId, count],
      );
    await setCount(100);
    const refused = await hold(g, g.freeServiceId, slot(9));
    expect(refused.statusCode).toBe(402);
    expect(refused.json().error.code).toBe('QUOTA_EXCEEDED');

    await setCount(99);
    ctx.events.clear();
    const accepted = await hold(g, g.freeServiceId, slot(9));
    expect(accepted.statusCode).toBe(201);
    const rows = await queryInTenant<{ ticket_count: number }>(
      ctx.pool,
      g.tenant.tenantId,
      'SELECT ticket_count FROM usage_counters WHERE location_id = $1',
      [g.locationId],
    );
    expect(rows[0]!.ticket_count).toBe(100);
    expect(eventsOfType(ctx, 'billing.quota.warning')).toHaveLength(1);
    expect(eventsOfType(ctx, 'billing.quota.exceeded')).toHaveLength(1);

    // A DP hold does not count until it is paid.
    await setCount(10);
    expect((await hold(g, g.dpServiceId, slot(10))).statusCode).toBe(201);
    const after = await queryInTenant<{ ticket_count: number }>(
      ctx.pool,
      g.tenant.tenantId,
      'SELECT ticket_count FROM usage_counters WHERE location_id = $1',
      [g.locationId],
    );
    expect(after[0]!.ticket_count).toBe(10);
  });
});

describe('calendar', () => {
  it('shows LOCKED, BOOKED, Redis-only locks, and past slots', async () => {
    const g = await setupBookingFixture(ctx);
    const held = (await hold(g, g.dpServiceId, slot(9))).json<BookingDto>();
    const confirmed = (await hold(g, g.freeServiceId, slot(10))).json<BookingDto>();
    await lock.acquire(slotLockKey(g.resourceIds[1], new Date(slot(11))), 'x', 60_000);

    const response = await calendar(g, '2026-10-20');
    expect(response.statusCode).toBe(200);
    const body = response.json<BookingCalendarResponse>();
    const row = (hour: number) => body.slots.find((s) => s.start_time === slot(hour))!;
    expect(row(9).resources[0]).toMatchObject({ state: 'LOCKED', booking: { id: held.id } });
    expect(row(9).resources[1]).toMatchObject({ state: 'AVAILABLE', booking: null });
    expect(row(10).resources[0]).toMatchObject({ state: 'BOOKED', booking: { id: confirmed.id } });
    expect(row(11).resources[1]).toMatchObject({ state: 'LOCKED', booking: null });
    expect(row(11).resources.map((r) => r.resource_name)).toEqual(['Ruang A', 'Ruang B']);
    await lock.release(slotLockKey(g.resourceIds[1], new Date(slot(11))), 'x');

    const today = (await calendar(g, '2026-10-19')).json<BookingCalendarResponse>();
    expect(today.slots[0]!.start_time).toBe(slot(0, 19));

    for (const headers of [g.owner, g.caller, g.cashier]) {
      expect((await calendar(g, '2026-10-20', headers)).statusCode).toBe(200);
    }
    expect((await calendar(g, '2026-10-20', {})).statusCode).toBe(401);
  });
});

describe('staff actions and cancel', () => {
  it('limits actions to owner and cashier and validates the transition', async () => {
    const start = slot(13);
    const booking = (await hold(f, f.freeServiceId, start)).json<BookingDto>();

    expect((await action(f, booking.id, 'COMPLETE', f.caller)).statusCode).toBe(403);
    expect((await action(f, booking.id, 'EXPIRE')).statusCode).toBe(400);
    expect((await action(f, 'not-a-uuid', 'COMPLETE')).statusCode).toBe(404);

    // NO_SHOW only once the start has passed.
    const early = await action(f, booking.id, 'NO_SHOW');
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('INVALID_TRANSITION');

    const completed = await action(f, booking.id, 'COMPLETE', f.owner);
    expect(completed.statusCode).toBe(200);
    expect(completed.json<BookingDto>().status).toBe('COMPLETED');
    expect(eventsFor('booking.reservation.completed', booking.id)).toHaveLength(1);
    expect((await action(f, booking.id, 'CANCEL')).statusCode).toBe(409);
  });

  it('marks NO_SHOW after the start and refuses CANCEL after the start', async () => {
    const start = slot(14, 19);
    clock.set(slot(13, 19));
    const booking = (await hold(f, f.freeServiceId, start)).json<BookingDto>();

    clock.set(new Date(new Date(start).getTime() + 60_000).toISOString());
    const cancel = await action(f, booking.id, 'CANCEL');
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error.code).toBe('INVALID_TRANSITION');

    const noShow = await action(f, booking.id, 'NO_SHOW');
    expect(noShow.statusCode).toBe(200);
    expect(noShow.json<BookingDto>().status).toBe('NO_SHOW');
    expect(eventsFor('booking.reservation.no_show', booking.id)).toHaveLength(1);
  });

  it('cancels a hold, releases the lock, and moves a PAID booking to REFUND_PENDING', async () => {
    const start = slot(15);
    const held = (await hold(f, f.dpServiceId, start)).json<BookingDto>();
    const key = slotLockKey(held.resource_id, new Date(start));
    expect((await lock.held([key])).size).toBe(1);

    const cancelled = await action(f, held.id, 'CANCEL');
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<BookingDto>()).toMatchObject({
      status: 'CANCELLED',
      payment_status: 'UNPAID',
    });
    expect((await lock.held([key])).size).toBe(0);
    expect(eventsFor('booking.reservation.cancelled', held.id)).toHaveLength(1);

    // Freed: the same slot can be held again, and a paid one is refunded when cancelled.
    const again = (await hold(f, f.dpServiceId, start, '6281111111112')).json<BookingDto>();
    await setBookingRow(
      f,
      "UPDATE bookings SET status = 'CONFIRMED', payment_status = 'PAID', dp_paid = dp_amount WHERE id = $1",
      [again.id],
    );
    const refunded = await action(f, again.id, 'CANCEL', f.owner);
    expect(refunded.json<BookingDto>()).toMatchObject({
      status: 'CANCELLED',
      payment_status: 'REFUND_PENDING',
    });
  });

  it('lets a customer cancel only their own booking and lists active bookings', async () => {
    const phone = '6281999999999';
    const booking = (await hold(f, f.freeServiceId, slot(16), phone)).json<BookingDto>();
    const headers = internalHeaders(ctx, f.tenant.tenantId);

    const active = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/bookings/active?location_id=${f.locationId}&customer_phone=${phone}`,
      headers,
    );
    expect(active.json<ActiveBookingsResponse>().bookings.map((b) => b.id)).toEqual([booking.id]);

    const other = await apiRequest(
      ctx.app,
      'POST',
      `/internal/v1/bookings/${booking.id}/cancel`,
      headers,
      {
        customer_phone: '6281888888888',
      },
    );
    expect(other.statusCode).toBe(404);

    const own = await apiRequest(
      ctx.app,
      'POST',
      `/internal/v1/bookings/${booking.id}/cancel`,
      headers,
      {
        customer_phone: phone,
      },
    );
    expect(own.statusCode).toBe(200);
    expect(own.json<BookingDto>().status).toBe('CANCELLED');
    const after = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/bookings/active?location_id=${f.locationId}&customer_phone=${phone}`,
      headers,
    );
    expect(after.json<ActiveBookingsResponse>().bookings).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('hides the bookings and locations of another tenant', async () => {
    const g = await setupBookingFixture(ctx);
    const booking = (await hold(f, f.freeServiceId, slot(17))).json<BookingDto>();

    expect((await action(g, booking.id, 'COMPLETE')).statusCode).toBe(404);
    expect(
      (await calendar(g, '2026-10-20'))
        .json<BookingCalendarResponse>()
        .slots.flatMap((s) => s.resources)
        .every((r) => r.booking === null),
    ).toBe(true);
    const crossCalendar = await apiRequest(
      ctx.app,
      'GET',
      `/api/v1/bookings?location_id=${f.locationId}&date=2026-10-20`,
      g.cashier,
    );
    expect(crossCalendar.statusCode).toBe(404);

    const cancel = await apiRequest(
      ctx.app,
      'POST',
      `/internal/v1/bookings/${booking.id}/cancel`,
      internalHeaders(ctx, g.tenant.tenantId),
      { customer_phone: booking.customer_phone },
    );
    expect(cancel.statusCode).toBe(404);

    const crossHold = await apiRequest(
      ctx.app,
      'POST',
      '/internal/v1/bookings/holds',
      internalHeaders(ctx, g.tenant.tenantId),
      {
        location_id: f.locationId,
        service_id: f.freeServiceId,
        slot_start: slot(18),
        customer_name: 'X',
        customer_phone: '6281111111111',
      },
    );
    expect(crossHold.statusCode).toBe(404);

    const unknownTenant = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/bookings/active?location_id=${f.locationId}&customer_phone=6281111111111`,
      internalHeaders(ctx, randomUUID()),
    );
    expect(unknownTenant.statusCode).toBe(404);
  });

  it('rejects an invalid token on the staff actions', async () => {
    const response = await apiRequest(
      ctx.app,
      'POST',
      `/api/v1/bookings/${randomUUID()}/actions`,
      bearer('bad'),
      { action: 'COMPLETE' },
    );
    expect(response.statusCode).toBe(401);
  });
});

describe('jobs', () => {
  function jobDeps(now: () => Date): BookingJobDeps {
    return {
      pool: ctx.pool,
      slotLock: lock,
      events: ctx.events,
      now,
      log: { warn: () => {}, error: () => {} },
    };
  }

  /** The next whole hour at least three hours ahead of the real time, as a UTC instant. */
  function futureSlot(): string {
    const date = new Date(Date.now() + 3 * 3_600_000);
    date.setUTCMinutes(0, 0, 0);
    date.setTime(date.getTime() + 3_600_000);
    // The last slot of the day starts at 22:00 WIB; 23:00 WIB has none.
    if ((date.getUTCHours() + 7) % 24 === 23) date.setTime(date.getTime() + 3_600_000);
    return date.toISOString();
  }

  it('expires a stale hold, releases its lock, and frees the slot', async () => {
    const g = await setupBookingFixture(ctx);
    const realClock = createClock(new Date().toISOString());
    const past = createClock(new Date(Date.now() - 10 * 60_000).toISOString());
    const app = await createTestApp({ now: past.now, slotLock: lock });
    try {
      const start = futureSlot();
      const headers = internalHeaders(app, g.tenant.tenantId);
      const response = await apiRequest(app.app, 'POST', '/internal/v1/bookings/holds', headers, {
        location_id: g.locationId,
        service_id: g.dpServiceId,
        slot_start: start,
        customer_name: 'Budi',
        customer_phone: '6281111111111',
      });
      expect(response.statusCode).toBe(201);
      const booking = response.json<BookingDto>();
      const key = slotLockKey(booking.resource_id, new Date(start));
      expect((await lock.held([key])).size).toBe(1);

      const result = await runExpiryJob({ ...jobDeps(realClock.now), events: app.events });
      expect(result.skipped).toBe(false);
      const rows = await queryInTenant<{ status: string; payment_status: string }>(
        ctx.pool,
        g.tenant.tenantId,
        'SELECT status, payment_status FROM bookings WHERE id = $1',
        [booking.id],
      );
      expect(rows[0]).toEqual({ status: 'EXPIRED', payment_status: 'UNPAID' });
      expect((await lock.held([key])).size).toBe(0);
      // Only this booking's events: other tests leave holds made at the fixed clock (2026-10-19)
      // that the job, which looks at the real clock, expires too.
      const expiredOf = () =>
        app.events.events.filter(
          (e) =>
            e.event_type === 'booking.reservation.expired' &&
            (e.data as { booking_id: string }).booking_id === booking.id,
        );
      expect(expiredOf()).toHaveLength(1);

      // A second run finds nothing for it, and the slot is bookable again.
      await runExpiryJob({ ...jobDeps(realClock.now), events: app.events });
      expect(expiredOf()).toHaveLength(1);
      const again = await apiRequest(app.app, 'POST', '/internal/v1/bookings/holds', headers, {
        location_id: g.locationId,
        service_id: g.dpServiceId,
        slot_start: start,
        customer_name: 'Siti',
        customer_phone: '6281111111112',
      });
      expect(again.statusCode).toBe(201);
      expect(again.json<BookingDto>().resource_id).toBe(booking.resource_id);
    } finally {
      await app.close();
    }
  });

  it('sends one reminder per booking when two workers run at once', async () => {
    const g = await setupBookingFixture(ctx);
    const real = createClock(new Date().toISOString());
    const app = await createTestApp({ now: real.now, slotLock: lock });
    try {
      const response = await apiRequest(
        app.app,
        'POST',
        '/internal/v1/bookings/holds',
        internalHeaders(app, g.tenant.tenantId),
        {
          location_id: g.locationId,
          service_id: g.freeServiceId,
          slot_start: futureSlot(),
          customer_name: 'Budi',
          customer_phone: '6281111111111',
        },
      );
      const booking = response.json<BookingDto>();
      await queryInTenant(
        ctx.pool,
        g.tenant.tenantId,
        `UPDATE bookings SET start_time = now() + interval '20 minutes',
                             end_time = now() + interval '80 minutes' WHERE id = $1`,
        [booking.id],
      );

      const deps = { ...jobDeps(real.now), events: app.events };
      const results = await Promise.all([runReminderJob(deps), runReminderJob({ ...deps })]);
      expect(results.reduce((sum, r) => sum + r.processed, 0)).toBeGreaterThanOrEqual(1);
      const reminders = () =>
        app.events.events.filter(
          (e) =>
            e.event_type === 'booking.reservation.reminder_due' &&
            (e.data as { booking_id: string }).booking_id === booking.id,
        );
      expect(reminders()).toHaveLength(1);
      const rows = await queryInTenant<{ reminder_sent_at: Date | null }>(
        ctx.pool,
        g.tenant.tenantId,
        'SELECT reminder_sent_at FROM bookings WHERE id = $1',
        [booking.id],
      );
      expect(rows[0]!.reminder_sent_at).not.toBeNull();

      const third = await runReminderJob(deps);
      expect(third.processed).toBe(0);
      expect(reminders()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
