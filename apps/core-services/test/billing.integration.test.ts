// S11 billing (FR-BILLING-01..05, spec sections 6.3, 7.3, 7.4): owner view of plan and usage,
// checkout -> signed callback -> PAID_LOCATION, late/repeated/wrong-amount/superseded callbacks,
// the FREE quota (402) and its monthly reset per location time zone, and the subscription job.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runSubscriptionJob } from '../src/billing/jobs.js';
import type { BillingOverview, CheckoutResponse } from '../src/billing/service.js';
import { signatureHeader } from '../src/payments/signature.js';
import {
  apiRequest,
  createClock,
  createTestApp,
  DEFAULT_CLOCK_ISO,
  eventsOfType,
  internalHeaders,
  queryInTenant,
  setupQueueFixture,
  type QueueFixture,
  type TestApp,
} from './helpers.js';

const MINUTE = 60_000;
const PRICE = 150000;
const clock = createClock(DEFAULT_CLOCK_ISO);
let ctx: TestApp;

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  ctx = await createTestApp({ now: clock.now });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(() => {
  clock.set(DEFAULT_CLOCK_ISO);
  ctx.events.clear();
});

function sql<Row extends Record<string, unknown>>(
  f: QueueFixture,
  query: string,
  params: unknown[] = [],
) {
  return queryInTenant<Row>(ctx.pool, f.tenant.tenantId, query, params);
}

async function setUsage(f: QueueFixture, periodMonth: string, count: number): Promise<void> {
  await sql(
    f,
    `INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (location_id, period_month) DO UPDATE SET ticket_count = $4`,
    [f.tenant.tenantId, f.locationId, periodMonth, count],
  );
}

function overview(f: QueueFixture) {
  return apiRequest(
    ctx.app,
    'GET',
    `/api/v1/billing/locations/${f.locationId}/subscription`,
    f.owner,
  );
}

async function checkout(f: QueueFixture): Promise<CheckoutResponse> {
  const response = await apiRequest(
    ctx.app,
    'POST',
    `/api/v1/billing/locations/${f.locationId}/subscription/checkout`,
    f.owner,
  );
  expect(response.statusCode).toBe(201);
  return response.json<CheckoutResponse>();
}

function callback(body: object, signed = true) {
  const raw = JSON.stringify(body);
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/billing/payments/callback',
    headers: {
      'content-type': 'application/json',
      ...(signed ? { 'x-antre-signature': signatureHeader(raw, ctx.paymentCallbackSecret) } : {}),
    },
    payload: raw,
  });
}

function paid(order: CheckoutResponse, overrides: object = {}) {
  return {
    payment_ref: order.payment.payment_ref,
    tenant_id: order.payment.tenant_id,
    target_id: order.payment.target_id,
    amount: order.payment.amount,
    status: 'PAID',
    ...overrides,
  };
}

function staffTicket(f: QueueFixture) {
  return apiRequest(ctx.app, 'POST', '/api/v1/queues/tickets', f.owner, {
    location_id: f.locationId,
    service_id: f.serviceId,
    customer_name: 'Budi',
  });
}

function waTicket(f: QueueFixture) {
  return apiRequest(
    ctx.app,
    'POST',
    '/internal/v1/queues/tickets',
    internalHeaders(ctx, f.tenant.tenantId),
    {
      location_id: f.locationId,
      service_id: f.serviceId,
      customer_phone: `62812${Math.floor(Math.random() * 1e8)
        .toString()
        .padStart(8, '0')}`,
    },
  );
}

async function subscriptionRow(f: QueueFixture) {
  const rows = await sql<{
    status: string;
    plan_code: string;
    pending_plan_code: string | null;
    current_period_start: Date | null;
    current_period_end: Date | null;
  }>(
    f,
    `SELECT status, plan_code, pending_plan_code, current_period_start, current_period_end
     FROM subscriptions WHERE location_id = $1`,
    [f.locationId],
  );
  return rows[0]!;
}

describe('owner view (FR-BILLING-01..03)', () => {
  it('shows a new location on FREE with its usage, history, and the plans', async () => {
    const f = await setupQueueFixture(ctx);
    expect((await staffTicket(f)).statusCode).toBe(201);

    const response = await overview(f);
    expect(response.statusCode).toBe(200);
    const body = response.json<BillingOverview>();
    expect(body.subscription).toMatchObject({
      plan_code: 'FREE',
      status: 'ACTIVE',
      pending_payment_ref: null,
      current_period_end: null,
      next_billing_at: null,
    });
    expect(body.usage).toEqual({
      period_month: '2026-10-01',
      ticket_count: 1,
      monthly_ticket_quota: 100,
      remaining: 99,
      percent_used: 1,
      exhausted: false,
    });
    expect(body.history).toEqual([{ period_month: '2026-10-01', ticket_count: 1 }]);

    const usage = await apiRequest(
      ctx.app,
      'GET',
      `/api/v1/billing/locations/${f.locationId}/usage`,
      f.owner,
    );
    expect(usage.json()).toMatchObject({ location_id: f.locationId, usage: { ticket_count: 1 } });

    const plans = await apiRequest(ctx.app, 'GET', '/api/v1/billing/plans', f.owner);
    expect(plans.json().plans).toEqual([
      { code: 'FREE', name: 'Gratis', price_idr_per_month: 0, monthly_ticket_quota: 100 },
      {
        code: 'PAID_LOCATION',
        name: 'Berbayar per Lokasi',
        price_idr_per_month: PRICE,
        monthly_ticket_quota: null,
      },
    ]);
  });

  it('is for the owner of the tenant only', async () => {
    const f = await setupQueueFixture(ctx);
    const other = await setupQueueFixture(ctx);
    for (const headers of [f.caller, f.cashier]) {
      const refused = await apiRequest(
        ctx.app,
        'GET',
        `/api/v1/billing/locations/${f.locationId}/subscription`,
        headers,
      );
      expect(refused.statusCode).toBe(403);
    }
    const foreign = await overview({ ...other, locationId: f.locationId });
    expect(foreign.statusCode).toBe(404);
    const checkoutForeign = await apiRequest(
      ctx.app,
      'POST',
      `/api/v1/billing/locations/${f.locationId}/subscription/checkout`,
      other.owner,
    );
    expect(checkoutForeign.statusCode).toBe(404);
    expect((await subscriptionRow(f)).status).toBe('ACTIVE');
  });
});

describe('FREE quota (FR-BILLING-04)', () => {
  it('refuses staff and WhatsApp tickets with 402 once 100 tickets are used', async () => {
    const f = await setupQueueFixture(ctx);
    await setUsage(f, '2026-10-01', 100);
    for (const response of [await staffTicket(f), await waTicket(f)]) {
      expect(response.statusCode).toBe(402);
      expect(response.json().error.code).toBe('QUOTA_EXCEEDED');
    }
    const body = (await overview(f)).json<BillingOverview>();
    expect(body.usage).toMatchObject({ ticket_count: 100, remaining: 0, percent_used: 100 });
    expect(body.usage.exhausted).toBe(true);
  });

  it('resets at midnight of the location time zone (monthly period)', async () => {
    const f = await setupQueueFixture(ctx);
    await setUsage(f, '2026-10-01', 100);
    // 2026-10-31 23:58 in Asia/Jakarta is still October.
    clock.set('2026-10-31T16:58:00Z');
    await f.refreshTokens();
    expect((await staffTicket(f)).statusCode).toBe(402);
    // 2026-11-01 00:30 WIB (still 31 October in UTC): the November counter starts at 0.
    clock.set('2026-10-31T17:30:00Z');
    await f.refreshTokens();
    const response = await staffTicket(f);
    expect(response.statusCode).toBe(201);
    const body = (await overview(f)).json<BillingOverview>();
    expect(body.usage).toMatchObject({ period_month: '2026-11-01', ticket_count: 1 });
    expect(body.history.map((entry) => entry.period_month)).toEqual(['2026-11-01', '2026-10-01']);
  });
});

describe('upgrade: checkout and signed callback (FR-BILLING-05, spec section 7.4)', () => {
  it('activates PAID_LOCATION for one month and lifts the quota', async () => {
    const f = await setupQueueFixture(ctx);
    await setUsage(f, '2026-10-01', 100);
    const order = await checkout(f);
    expect(order.subscription).toMatchObject({
      status: 'PENDING_PAYMENT',
      plan_code: 'FREE',
      pending_plan_code: 'PAID_LOCATION',
      pending_payment_ref: order.payment.payment_ref,
      pending_expires_at: '2026-10-19T03:15:00.000Z',
    });
    expect(order.payment).toMatchObject({
      tenant_id: f.tenant.tenantId,
      plan_code: 'PAID_LOCATION',
      amount: PRICE,
      currency: 'IDR',
      callback_path: '/api/v1/billing/payments/callback',
    });
    expect(order.payment.payment_ref).toMatch(/^sub-[0-9a-f]{24}$/);
    // Still FREE while the payment is pending.
    expect((await staffTicket(f)).statusCode).toBe(402);

    clock.advance(5 * MINUTE);
    const response = await callback(paid(order));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      subscription_id: order.payment.target_id,
      status: 'ACTIVE',
      plan_code: 'PAID_LOCATION',
      current_period_end: '2026-11-19T03:05:00.000Z',
    });
    const activated = eventsOfType(ctx, 'billing.subscription.activated');
    expect(activated).toHaveLength(1);
    expect(activated[0]).toMatchObject({
      tenant: { id: f.tenant.tenantId },
      location: { id: f.locationId },
      data: {
        subscription_id: order.payment.target_id,
        plan_code: 'PAID_LOCATION',
        payment_ref: order.payment.payment_ref,
        current_period_start: '2026-10-19T03:05:00.000Z',
        current_period_end: '2026-11-19T03:05:00.000Z',
      },
    });

    // Unlimited now: the 101st ticket of the month is accepted.
    expect((await staffTicket(f)).statusCode).toBe(201);
    expect((await waTicket(f)).statusCode).toBe(201);
    const body = (await overview(f)).json<BillingOverview>();
    expect(body.subscription).toMatchObject({
      plan_code: 'PAID_LOCATION',
      status: 'ACTIVE',
      next_billing_at: '2026-11-19T03:05:00.000Z',
    });
    expect(body.usage).toMatchObject({
      ticket_count: 102,
      monthly_ticket_quota: null,
      remaining: null,
      exhausted: false,
    });

    // A repeated callback changes nothing and is answered like the first one.
    ctx.events.clear();
    const again = await callback(paid(order));
    expect(again.statusCode).toBe(200);
    expect(again.json().current_period_end).toBe('2026-11-19T03:05:00.000Z');
    expect(ctx.events.events).toHaveLength(0);
  });

  it('extends a running period by one month from its end (renewal)', async () => {
    const f = await setupQueueFixture(ctx);
    expect((await callback(paid(await checkout(f)))).statusCode).toBe(200);
    clock.advance(10 * 24 * 60 * MINUTE);
    await f.refreshTokens();
    const renewal = await checkout(f);
    expect(renewal.subscription).toMatchObject({
      status: 'PENDING_PAYMENT',
      plan_code: 'PAID_LOCATION',
    });
    const response = await callback(paid(renewal));
    expect(response.statusCode).toBe(200);
    expect(response.json().current_period_end).toBe('2026-12-19T03:00:00.000Z');
    expect((await subscriptionRow(f)).current_period_start?.toISOString()).toBe(
      '2026-10-19T03:00:00.000Z',
    );
  });

  it('answers a late callback 409 and closes the checkout without activating', async () => {
    const f = await setupQueueFixture(ctx);
    const order = await checkout(f);
    clock.advance(16 * MINUTE);
    const response = await callback(paid(order));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'PAYMENT_NOT_APPLICABLE',
      details: { status: 'ACTIVE', plan_code: 'FREE' },
    });
    expect(await subscriptionRow(f)).toMatchObject({
      status: 'ACTIVE',
      plan_code: 'FREE',
      pending_plan_code: null,
    });
    // Replayed: still 409, still FREE.
    expect((await callback(paid(order))).statusCode).toBe(409);
    expect((await subscriptionRow(f)).plan_code).toBe('FREE');
    expect(eventsOfType(ctx, 'billing.subscription.activated')).toHaveLength(0);
  });

  it('answers a wrong amount 409 and closes the checkout', async () => {
    const f = await setupQueueFixture(ctx);
    const order = await checkout(f);
    const response = await callback(paid(order, { amount: 100000 }));
    expect(response.statusCode).toBe(409);
    expect(await subscriptionRow(f)).toMatchObject({ status: 'ACTIVE', plan_code: 'FREE' });
    // The right amount afterwards cannot reuse the closed checkout.
    expect((await callback(paid(order))).statusCode).toBe(409);
  });

  it('replaces an open checkout: the old payment_ref never activates', async () => {
    const f = await setupQueueFixture(ctx);
    const first = await checkout(f);
    const second = await checkout(f);
    expect(second.payment.payment_ref).not.toBe(first.payment.payment_ref);
    expect((await callback(paid(first))).statusCode).toBe(409);
    expect((await subscriptionRow(f)).status).toBe('PENDING_PAYMENT');
    expect((await callback(paid(second))).statusCode).toBe(200);
    expect((await subscriptionRow(f)).plan_code).toBe('PAID_LOCATION');
  });

  it('checks the signature first and scopes the target to the payload tenant', async () => {
    const f = await setupQueueFixture(ctx);
    const other = await setupQueueFixture(ctx);
    const order = await checkout(f);
    expect((await callback(paid(order), false)).statusCode).toBe(401);
    const foreign = await callback(paid(order, { tenant_id: other.tenant.tenantId }));
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('PAYMENT_TARGET_NOT_FOUND');
    expect((await callback(paid(order, { target_id: randomUUID() }))).statusCode).toBe(404);
    expect((await callback(paid(order, { status: 'FAILED' }))).json()).toEqual({ ignored: true });
    expect((await subscriptionRow(f)).status).toBe('PENDING_PAYMENT');
  });
});

describe('subscription job (spec section 6.3)', () => {
  it('downgrades an ended PAID_LOCATION period to FREE and the quota applies at once', async () => {
    const f = await setupQueueFixture(ctx);
    expect((await callback(paid(await checkout(f)))).statusCode).toBe(200);
    await setUsage(f, '2026-10-01', 120);
    expect((await staffTicket(f)).statusCode).toBe(201);
    // The job compares with the database clock: move the period into the real past.
    await sql(
      f,
      `UPDATE subscriptions
       SET current_period_start = now() - interval '31 days',
           current_period_end = now() - interval '1 minute'
       WHERE location_id = $1`,
      [f.locationId],
    );
    const deps = { pool: ctx.pool, now: () => new Date(), log: silentLog };
    const [a, b] = await Promise.all([runSubscriptionJob(deps), runSubscriptionJob(deps)]);
    // One runner holds the advisory lock (or both ran one after the other): applied exactly once.
    expect(a.skipped && b.skipped).toBe(false);
    expect(await subscriptionRow(f)).toMatchObject({
      status: 'ACTIVE',
      plan_code: 'FREE',
      current_period_start: null,
      current_period_end: null,
    });
    const refused = await staffTicket(f);
    expect(refused.statusCode).toBe(402);
    expect((await runSubscriptionJob(deps)).skipped).toBe(false);
    expect((await subscriptionRow(f)).plan_code).toBe('FREE');
  });

  it('closes an expired checkout; its late callback is then 409', async () => {
    const f = await setupQueueFixture(ctx);
    const order = await checkout(f);
    await sql(
      f,
      `UPDATE subscriptions SET pending_expires_at = now() - interval '1 minute'
       WHERE location_id = $1`,
      [f.locationId],
    );
    await runSubscriptionJob({ pool: ctx.pool, now: () => new Date(), log: silentLog });
    expect(await subscriptionRow(f)).toMatchObject({
      status: 'ACTIVE',
      plan_code: 'FREE',
      pending_plan_code: null,
    });
    expect((await callback(paid(order))).statusCode).toBe(409);
  });
});
