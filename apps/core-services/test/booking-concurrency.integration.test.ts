import { createClient } from '@redis/client';
import type { BookingDto } from '@antre/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RedisSlotLock,
  SlotLockUnavailableError,
  slotLockKey,
  type SlotLock,
} from '../src/booking/slot-lock.js';
import {
  apiRequest,
  createClock,
  createTestApp,
  DEFAULT_CLOCK_ISO,
  internalHeaders,
  queryInTenant,
  redisSlotLock,
  setupBookingFixture,
  type BookingFixture,
  type TestApp,
} from './helpers.js';

const PARALLEL = 55;
const START = '2026-10-20T03:00:00.000Z';
const clock = createClock(DEFAULT_CLOCK_ISO);

let lock: RedisSlotLock;

beforeAll(async () => {
  lock = await redisSlotLock();
});

afterAll(async () => {
  await lock.close();
});

/**
 * A lock store that lets the first five callers of `acquire` meet before any answers, so that
 * several holds are certain to have passed the database check before the first one commits.
 */
class BarrierSlotLock implements SlotLock {
  private arrivals = 0;
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });

  constructor(private readonly mode: 'grant' | 'unavailable') {}

  async acquire(): Promise<boolean> {
    this.arrivals += 1;
    if (this.arrivals >= 5) this.open();
    await this.gate;
    if (this.mode === 'unavailable') throw new SlotLockUnavailableError();
    return true;
  }

  async release(): Promise<boolean> {
    return true;
  }

  async held(): Promise<Set<string>> {
    return new Set();
  }
}

/** A fixture with a single active resource, so every hold competes for the same cell. */
async function singleResourceFixture(ctx: TestApp): Promise<BookingFixture> {
  const f = await setupBookingFixture(ctx);
  const response = await apiRequest(
    ctx.app,
    'PATCH',
    `/api/v1/catalog/resources/${f.resourceIds[1]}`,
    f.owner,
    { is_active: false },
  );
  expect(response.statusCode).toBe(200);
  return f;
}

function holdAll(ctx: TestApp, f: BookingFixture) {
  return Promise.all(
    Array.from({ length: PARALLEL }, (_, index) =>
      apiRequest(
        ctx.app,
        'POST',
        '/internal/v1/bookings/holds',
        internalHeaders(ctx, f.tenant.tenantId),
        {
          location_id: f.locationId,
          service_id: f.dpServiceId,
          slot_start: START,
          customer_name: `Pelanggan ${index}`,
          customer_phone: `62811000${String(index).padStart(4, '0')}`,
        },
      ),
    ),
  );
}

function holdOnce(ctx: TestApp, f: BookingFixture, phone: string) {
  return apiRequest(
    ctx.app,
    'POST',
    '/internal/v1/bookings/holds',
    internalHeaders(ctx, f.tenant.tenantId),
    {
      location_id: f.locationId,
      service_id: f.dpServiceId,
      slot_start: START,
      customer_name: 'Budi',
      customer_phone: phone,
    },
  );
}

async function activeRows(ctx: TestApp, f: BookingFixture) {
  return queryInTenant<{ id: string; hold_token: string }>(
    ctx.pool,
    f.tenant.tenantId,
    `SELECT id, hold_token FROM bookings WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED')`,
  );
}

describe('parallel holds of one slot', () => {
  it('lets exactly one of 55 holds win with the real Redis lock', async () => {
    const ctx = await createTestApp({ now: clock.now, slotLock: lock });
    try {
      const f = await singleResourceFixture(ctx);
      const responses = await holdAll(ctx, f);

      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      const losers = responses.filter((r) => r.statusCode !== 201);
      expect(losers).toHaveLength(PARALLEL - 1);
      expect(losers.map((r) => r.statusCode)).toEqual(Array(PARALLEL - 1).fill(409));
      expect(losers.map((r) => r.json().error.code)).toEqual(
        Array(PARALLEL - 1).fill('SLOT_LOCKED'),
      );

      const rows = await activeRows(ctx, f);
      expect(rows).toHaveLength(1);
      const winner = responses.find((r) => r.statusCode === 201)!.json<BookingDto>();
      expect(rows[0]!.id).toBe(winner.id);

      const redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      try {
        const key = slotLockKey(f.resourceIds[0], new Date(START));
        expect(await redis.get(key)).toBe(rows[0]!.hold_token);
        const ttl = await redis.pTTL(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(300_000);
      } finally {
        await redis.close();
      }
    } finally {
      await ctx.close();
    }
  });

  for (const [title, mode] of [
    ['when the lock never says no (lock lost)', 'grant'],
    ['when Redis is unavailable (fallback)', 'unavailable'],
  ] as const) {
    it(`is still held to one by the unique index ${title}`, async () => {
      const ctx = await createTestApp({ now: clock.now, slotLock: new BarrierSlotLock(mode) });
      try {
        const f = await singleResourceFixture(ctx);
        const responses = await holdAll(ctx, f);

        expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
        const codes = responses.filter((r) => r.statusCode !== 201).map((r) => r.json().error.code);
        expect(codes).toHaveLength(PARALLEL - 1);
        for (const code of codes) expect(['SLOT_TAKEN', 'SLOT_LOCKED']).toContain(code);
        // The first holds all passed the database check together: the index caught them.
        expect(codes.filter((code) => code === 'SLOT_TAKEN').length).toBeGreaterThanOrEqual(4);
        expect(await activeRows(ctx, f)).toHaveLength(1);
      } finally {
        await ctx.close();
      }
    });
  }
});

describe('release', () => {
  it('does not delete a key that holds another token', async () => {
    const key = slotLockKey('11111111-1111-4111-8111-111111111111', new Date(START));
    expect(await lock.acquire(key, 'token-a', 60_000)).toBe(true);
    expect(await lock.acquire(key, 'token-b', 60_000)).toBe(false);
    expect(await lock.release(key, 'token-b')).toBe(false);
    expect((await lock.held([key])).has(key)).toBe(true);
    expect(await lock.release(key, 'token-a')).toBe(true);
    expect((await lock.held([key])).size).toBe(0);
  });
});

describe('Redis that is down from the start', () => {
  it('fails every command fast and lets holds fall back to the database', async () => {
    const dead = new RedisSlotLock({
      url: 'redis://127.0.0.1:1',
      commandTimeoutMs: 300,
      log: { warn: () => {} },
    });
    await expect(dead.connect(500)).rejects.toBeInstanceOf(SlotLockUnavailableError);
    await expect(dead.acquire('k', 't', 1000)).rejects.toBeInstanceOf(SlotLockUnavailableError);
    await expect(dead.held(['k'])).rejects.toBeInstanceOf(SlotLockUnavailableError);

    const ctx = await createTestApp({ now: clock.now, slotLock: dead });
    try {
      const f = await singleResourceFixture(ctx);
      const first = await holdOnce(ctx, f, '6281100000001');
      expect(first.statusCode).toBe(201);
      const second = await holdOnce(ctx, f, '6281100000002');
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('SLOT_LOCKED');
      expect(await activeRows(ctx, f)).toHaveLength(1);
    } finally {
      await ctx.close();
      await dead.close();
    }
  });
});
