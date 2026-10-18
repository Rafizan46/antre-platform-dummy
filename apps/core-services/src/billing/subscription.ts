// Pure rules of the location subscription (FR-BILLING-02..05, spec sections 6.3 and 7.4): billing
// periods, the payment callback decision table, and the usage summary. No database access here,
// so the rules are unit-tested on their own.
import type { PlanCode, SubscriptionStatus } from '@antre/shared-types';

/** Checkout QRIS validity (FR-BILLING-05: 15 minutes). */
export const CHECKOUT_TTL_MS = 15 * 60_000;
/** Months shown in the usage history of a location. */
export const USAGE_HISTORY_MONTHS = 6;

export interface SubscriptionState {
  status: SubscriptionStatus;
  plan_code: PlanCode;
  pending_plan_code: PlanCode | null;
  payment_ref: string | null;
  last_paid_ref: string | null;
  pending_expires_at: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  /** price_idr_per_month of pending_plan_code (null when nothing is pending). */
  pending_price: number | null;
}

export interface BillingPeriod {
  start: Date;
  end: Date;
}

/**
 * `date` plus `months` calendar months in UTC; a day that does not exist in the target month is
 * clamped to its last day (31 January + 1 month = 28/29 February).
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * Period after a payment at `now` (spec section 6.3): a running PAID_LOCATION period is extended by
 * one month from its end; otherwise a new one-month period starts at the payment.
 */
export function nextPeriod(state: SubscriptionState, now: Date): BillingPeriod {
  if (
    state.plan_code === 'PAID_LOCATION' &&
    state.current_period_start !== null &&
    state.current_period_end !== null &&
    state.current_period_end.getTime() > now.getTime()
  ) {
    return { start: state.current_period_start, end: addMonths(state.current_period_end, 1) };
  }
  return { start: now, end: addMonths(now, 1) };
}

/** Whether a PENDING_PAYMENT checkout is past `pending_expires_at` at `now`. */
export function pendingExpired(state: SubscriptionState, now: Date): boolean {
  return (
    state.status === 'PENDING_PAYMENT' &&
    state.pending_expires_at !== null &&
    state.pending_expires_at.getTime() <= now.getTime()
  );
}

/** Whether a PAID_LOCATION period has ended at `now` (the job falls back to FREE). */
export function periodEnded(state: SubscriptionState, now: Date): boolean {
  return (
    state.plan_code === 'PAID_LOCATION' &&
    state.current_period_end !== null &&
    state.current_period_end.getTime() <= now.getTime()
  );
}

function sameAmount(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

export type CallbackDecision =
  /** payment_ref = last_paid_ref: a repeated callback, answered 200 without changes. */
  | { kind: 'already-applied' }
  /** On time and the right amount: ACTIVE, PAID_LOCATION, `period`. */
  | { kind: 'apply'; period: BillingPeriod }
  /**
   * 409 PAYMENT_NOT_APPLICABLE. `expirePending` = the checkout is still PENDING_PAYMENT and is
   * closed first (back to ACTIVE, plan unchanged); the money goes to manual refund (audit log).
   */
  | {
      kind: 'reject';
      reason: 'late' | 'amount-mismatch' | 'not-pending' | 'superseded';
      expirePending: boolean;
    };

/** The subscription half of the section 7.4 decision table, for a PAID callback. */
export function decideSubscriptionCallback(
  state: SubscriptionState,
  paymentRef: string,
  amount: number,
  now: Date,
): CallbackDecision {
  if (state.last_paid_ref !== null && paymentRef === state.last_paid_ref) {
    return { kind: 'already-applied' };
  }
  if (paymentRef !== state.payment_ref) {
    // An older checkout that a newer one replaced: never applied, nothing changes.
    return { kind: 'reject', reason: 'superseded', expirePending: false };
  }
  if (state.status !== 'PENDING_PAYMENT') {
    // The checkout already expired (job, new checkout, or an earlier late callback).
    return { kind: 'reject', reason: 'not-pending', expirePending: false };
  }
  if (pendingExpired(state, now)) {
    return { kind: 'reject', reason: 'late', expirePending: true };
  }
  if (state.pending_price === null || !sameAmount(state.pending_price, amount)) {
    // Decision S11 (like S07 for bookings): a wrong amount closes the checkout; refund manually.
    return { kind: 'reject', reason: 'amount-mismatch', expirePending: true };
  }
  return { kind: 'apply', period: nextPeriod(state, now) };
}

export interface UsageSummary {
  period_month: string;
  ticket_count: number;
  /** null = unlimited (PAID_LOCATION). */
  monthly_ticket_quota: number | null;
  /** null = unlimited. */
  remaining: number | null;
  /** Rounded down; null = unlimited. May exceed 100 after a downgrade to FREE. */
  percent_used: number | null;
  /** FREE and the quota is used up: new tickets and holds get 402 QUOTA_EXCEEDED. */
  exhausted: boolean;
}

export function usageSummary(
  periodMonth: string,
  ticketCount: number,
  quota: number | null,
): UsageSummary {
  if (quota === null) {
    return {
      period_month: periodMonth,
      ticket_count: ticketCount,
      monthly_ticket_quota: null,
      remaining: null,
      percent_used: null,
      exhausted: false,
    };
  }
  return {
    period_month: periodMonth,
    ticket_count: ticketCount,
    monthly_ticket_quota: quota,
    remaining: Math.max(0, quota - ticketCount),
    percent_used: Math.floor((ticketCount * 100) / quota),
    exhausted: ticketCount >= quota,
  };
}
