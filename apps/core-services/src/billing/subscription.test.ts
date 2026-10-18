import { describe, expect, it } from 'vitest';

import {
  addMonths,
  decideSubscriptionCallback,
  nextPeriod,
  pendingExpired,
  periodEnded,
  usageSummary,
  type SubscriptionState,
} from './subscription.js';

const NOW = new Date('2026-10-19T03:00:00Z');
const MINUTE = 60_000;

function state(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    status: 'PENDING_PAYMENT',
    plan_code: 'FREE',
    pending_plan_code: 'PAID_LOCATION',
    payment_ref: 'sub-new',
    last_paid_ref: null,
    pending_expires_at: new Date(NOW.getTime() + 10 * MINUTE),
    current_period_start: null,
    current_period_end: null,
    pending_price: 150000,
    ...overrides,
  };
}

describe('addMonths', () => {
  it('adds calendar months in UTC', () => {
    expect(addMonths(NOW, 1).toISOString()).toBe('2026-11-19T03:00:00.000Z');
    expect(addMonths(new Date('2026-12-15T00:00:00Z'), 1).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });

  it('clamps to the last day of a shorter month', () => {
    expect(addMonths(new Date('2027-01-31T10:00:00Z'), 1).toISOString()).toBe(
      '2027-02-28T10:00:00.000Z',
    );
    expect(addMonths(new Date('2028-01-31T10:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
  });
});

describe('nextPeriod', () => {
  it('starts one month at the payment for FREE or an ended period', () => {
    expect(nextPeriod(state(), NOW)).toEqual({ start: NOW, end: addMonths(NOW, 1) });
    const ended = state({
      plan_code: 'PAID_LOCATION',
      current_period_start: new Date('2026-09-01T00:00:00Z'),
      current_period_end: new Date('2026-10-01T00:00:00Z'),
    });
    expect(nextPeriod(ended, NOW)).toEqual({ start: NOW, end: addMonths(NOW, 1) });
  });

  it('extends a running PAID_LOCATION period by one month from its end', () => {
    const start = new Date('2026-10-01T00:00:00Z');
    const end = new Date('2026-11-01T00:00:00Z');
    const running = state({
      plan_code: 'PAID_LOCATION',
      current_period_start: start,
      current_period_end: end,
    });
    expect(nextPeriod(running, NOW)).toEqual({
      start,
      end: new Date('2026-12-01T00:00:00Z'),
    });
  });
});

describe('pendingExpired and periodEnded', () => {
  it('compare the deadlines with now (inclusive)', () => {
    expect(pendingExpired(state({ pending_expires_at: NOW }), NOW)).toBe(true);
    expect(pendingExpired(state(), NOW)).toBe(false);
    expect(pendingExpired(state({ status: 'ACTIVE', pending_expires_at: NOW }), NOW)).toBe(false);
    const paid = state({
      status: 'ACTIVE',
      plan_code: 'PAID_LOCATION',
      current_period_start: new Date('2026-09-19T03:00:00Z'),
      current_period_end: NOW,
    });
    expect(periodEnded(paid, NOW)).toBe(true);
    expect(periodEnded(paid, new Date(NOW.getTime() - 1))).toBe(false);
    expect(periodEnded(state(), NOW)).toBe(false);
  });
});

describe('decideSubscriptionCallback (spec section 7.4)', () => {
  it('applies an on-time payment of the right amount', () => {
    expect(decideSubscriptionCallback(state(), 'sub-new', 150000, NOW)).toEqual({
      kind: 'apply',
      period: { start: NOW, end: addMonths(NOW, 1) },
    });
    expect(decideSubscriptionCallback(state(), 'sub-new', 150000.0, NOW).kind).toBe('apply');
  });

  it('answers a repeated callback of the applied payment_ref without changes', () => {
    const applied = state({ status: 'ACTIVE', last_paid_ref: 'sub-new', pending_plan_code: null });
    expect(decideSubscriptionCallback(applied, 'sub-new', 150000, NOW)).toEqual({
      kind: 'already-applied',
    });
  });

  it('rejects a late payment and closes the checkout', () => {
    const late = state({ pending_expires_at: new Date(NOW.getTime() - MINUTE) });
    expect(decideSubscriptionCallback(late, 'sub-new', 150000, NOW)).toEqual({
      kind: 'reject',
      reason: 'late',
      expirePending: true,
    });
  });

  it('rejects a wrong amount and closes the checkout', () => {
    expect(decideSubscriptionCallback(state(), 'sub-new', 100000, NOW)).toEqual({
      kind: 'reject',
      reason: 'amount-mismatch',
      expirePending: true,
    });
  });

  it('rejects a superseded payment_ref without touching the open checkout', () => {
    expect(decideSubscriptionCallback(state(), 'sub-old', 150000, NOW)).toEqual({
      kind: 'reject',
      reason: 'superseded',
      expirePending: false,
    });
  });

  it('rejects the ref of a checkout that already expired (job or earlier late callback)', () => {
    const closed = state({ status: 'ACTIVE', pending_plan_code: null, pending_expires_at: null });
    expect(decideSubscriptionCallback(closed, 'sub-new', 150000, NOW)).toEqual({
      kind: 'reject',
      reason: 'not-pending',
      expirePending: false,
    });
  });
});

describe('usageSummary', () => {
  it('reports remaining quota and percentage for FREE', () => {
    expect(usageSummary('2026-10-01', 80, 100)).toEqual({
      period_month: '2026-10-01',
      ticket_count: 80,
      monthly_ticket_quota: 100,
      remaining: 20,
      percent_used: 80,
      exhausted: false,
    });
    expect(usageSummary('2026-10-01', 100, 100)).toMatchObject({ remaining: 0, exhausted: true });
    expect(usageSummary('2026-10-01', 150, 100)).toMatchObject({
      remaining: 0,
      percent_used: 150,
      exhausted: true,
    });
  });

  it('reports unlimited usage for PAID_LOCATION', () => {
    expect(usageSummary('2026-10-01', 250, null)).toEqual({
      period_month: '2026-10-01',
      ticket_count: 250,
      monthly_ticket_quota: null,
      remaining: null,
      percent_used: null,
      exhausted: false,
    });
  });
});
