// Location subscription use cases (FR-BILLING-02..05): the owner's view of plan and usage, the
// simulated QRIS checkout, the signed subscription callback (spec section 7.4), and the periodic
// subscription job (spec section 6.3).
import { randomBytes } from 'node:crypto';

import { createEvent, type EventEnvelope } from '@antre/event-contracts';
import type { PaymentCallback, PlanCode, SubscriptionStatus } from '@antre/shared-types';
import type pg from 'pg';

import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { publishAll, type EventPublisher } from '../events/publisher.js';
import { getLocationContext, type LocationContext } from '../queue/queries.js';
import {
  activatePaid,
  dueSubscriptions,
  endPeriodIfDue,
  expirePending,
  expirePendingIfDue,
  getPlan,
  startCheckout,
  subscriptionById,
  subscriptionByLocation,
  usageHistory,
  type SubscriptionRow,
} from './queries.js';
import {
  CHECKOUT_TTL_MS,
  USAGE_HISTORY_MONTHS,
  decideSubscriptionCallback,
  pendingExpired,
  usageSummary,
  type UsageSummary,
} from './subscription.js';

const PAID_PLAN: PlanCode = 'PAID_LOCATION';

export interface BillingLogger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface SubscriptionDto {
  id: string;
  location_id: string;
  plan_code: PlanCode;
  status: SubscriptionStatus;
  pending_plan_code: PlanCode | null;
  /** payment_ref of the open checkout (null when nothing is pending). */
  pending_payment_ref: string | null;
  pending_expires_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  /** PAID_LOCATION: end of the paid period (renew before it); FREE: null. */
  next_billing_at: string | null;
}

export interface BillingOverview {
  subscription: SubscriptionDto;
  usage: UsageSummary;
  history: { period_month: string; ticket_count: number }[];
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toSubscriptionDto(row: SubscriptionRow): SubscriptionDto {
  const pending = row.status === 'PENDING_PAYMENT';
  return {
    id: row.id,
    location_id: row.location_id,
    plan_code: row.plan_code,
    status: row.status,
    pending_plan_code: row.pending_plan_code,
    pending_payment_ref: pending ? row.payment_ref : null,
    pending_expires_at: pending ? iso(row.pending_expires_at) : null,
    current_period_start: iso(row.current_period_start),
    current_period_end: iso(row.current_period_end),
    next_billing_at: row.plan_code === PAID_PLAN ? iso(row.current_period_end) : null,
  };
}

async function locationOr404(
  client: pg.PoolClient,
  locationId: string,
  now: Date,
): Promise<LocationContext> {
  const context = await getLocationContext(client, locationId, now.toISOString());
  if (context === null) throw new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.');
  return context;
}

/** GET .../subscription and .../usage: plan, status, period, usage of the local month, history. */
export async function billingOverview(
  client: pg.PoolClient,
  locationId: string,
  now: Date,
): Promise<BillingOverview> {
  const context = await locationOr404(client, locationId, now);
  const row = await subscriptionByLocation(client, locationId);
  if (row === null) throw new AppError('NOT_FOUND', 'Langganan lokasi tidak ditemukan.');
  const plan = await getPlan(client, row.plan_code);
  const history = await usageHistory(client, locationId, USAGE_HISTORY_MONTHS);
  const current = history.find((entry) => entry.period_month === context.period_month);
  return {
    subscription: toSubscriptionDto(row),
    usage: usageSummary(
      context.period_month,
      current?.ticket_count ?? 0,
      plan?.monthly_ticket_quota ?? null,
    ),
    history,
  };
}

export interface CheckoutResponse {
  subscription: SubscriptionDto;
  payment: {
    payment_ref: string;
    tenant_id: string;
    target_id: string;
    plan_code: PlanCode;
    amount: number;
    currency: 'IDR';
    expires_at: string;
    /** Content of the simulated QRIS (no real payment gateway, decision D11). */
    qris_payload: string;
    callback_path: '/api/v1/billing/payments/callback';
    instructions: string;
  };
}

/**
 * POST .../subscription/checkout (FR-BILLING-05): a new payment_ref and a simulated QRIS valid for
 * 15 minutes. An open checkout is replaced (its payment_ref can no longer activate anything).
 */
export async function checkout(
  client: pg.PoolClient,
  tenantId: string,
  locationId: string,
  now: Date,
  log: BillingLogger,
): Promise<CheckoutResponse> {
  await locationOr404(client, locationId, now);
  const row = await subscriptionByLocation(client, locationId, true);
  if (row === null) throw new AppError('NOT_FOUND', 'Langganan lokasi tidak ditemukan.');
  const plan = await getPlan(client, PAID_PLAN);
  if (plan === null) throw new Error('plan PAID_LOCATION is missing');

  const nowIso = now.toISOString();
  if (row.status === 'PENDING_PAYMENT') {
    // Spec section 6.3: a new checkout closes the old one first.
    await expirePending(client, row.id, nowIso);
    log.info(
      { subscription_id: row.id, payment_ref: row.payment_ref, expired: pendingExpired(row, now) },
      'subscription checkout replaced',
    );
  }
  const paymentRef = `sub-${randomBytes(12).toString('hex')}`;
  const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS).toISOString();
  await startCheckout(client, row.id, { planCode: PAID_PLAN, paymentRef, expiresAt, nowIso });
  const updated = (await subscriptionById(client, row.id))!;

  return {
    subscription: toSubscriptionDto(updated),
    payment: {
      payment_ref: paymentRef,
      tenant_id: tenantId,
      target_id: row.id,
      plan_code: PAID_PLAN,
      amount: plan.price_idr_per_month,
      currency: 'IDR',
      expires_at: expiresAt,
      qris_payload: `ANTRE-QRIS-SIMULASI|${paymentRef}|${plan.price_idr_per_month}`,
      callback_path: '/api/v1/billing/payments/callback',
      instructions:
        `Pindai QRIS simulasi dan bayar Rp${plan.price_idr_per_month.toLocaleString('id-ID')} ` +
        'sebelum batas waktu (15 menit). Paket Berbayar per Lokasi aktif 1 bulan setelah ' +
        'pembayaran dikonfirmasi; tiket tidak lagi dibatasi kuota.',
    },
  };
}

export interface SubscriptionCallbackBody {
  subscription_id: string;
  status: SubscriptionStatus;
  plan_code: PlanCode;
  current_period_end: string | null;
}

export interface SubscriptionCallbackOutcome {
  body: SubscriptionCallbackBody;
  conflict: string | null;
  events: EventEnvelope[];
}

function callbackBody(row: SubscriptionRow): SubscriptionCallbackBody {
  return {
    subscription_id: row.id,
    status: row.status,
    plan_code: row.plan_code,
    current_period_end: iso(row.current_period_end),
  };
}

const CONFLICT_MESSAGES = {
  late: 'Batas waktu pembayaran langganan terlewati; dana akan dikembalikan.',
  'amount-mismatch': 'Nominal pembayaran langganan tidak sesuai; dana akan dikembalikan.',
  'not-pending': 'Checkout langganan ini sudah tidak berlaku; dana akan dikembalikan.',
  superseded: 'Checkout langganan ini sudah digantikan; dana akan dikembalikan.',
} as const;

/** The subscription half of the section 7.4 decision table; the row is locked FOR UPDATE. */
export async function handleSubscriptionCallback(
  client: pg.PoolClient,
  env: { tenantId: string; now: Date; log: BillingLogger },
  payload: PaymentCallback,
): Promise<SubscriptionCallbackOutcome> {
  const row = await subscriptionById(client, payload.target_id, true);
  if (row === null) {
    throw new AppError('PAYMENT_TARGET_NOT_FOUND', 'Tujuan pembayaran tidak ditemukan.');
  }
  const nowIso = env.now.toISOString();
  const decision = decideSubscriptionCallback(row, payload.payment_ref, payload.amount, env.now);

  if (decision.kind === 'already-applied') {
    return { body: callbackBody(row), conflict: null, events: [] };
  }
  if (decision.kind === 'reject') {
    if (decision.expirePending) await expirePending(client, row.id, nowIso);
    // Audit log for the manual refund by the Super Admin (spec section 7.4 point 4).
    env.log.warn(
      {
        audit: 'payment_not_applicable',
        reason: decision.reason,
        subscription_id: row.id,
        tenant_id: env.tenantId,
        payment_ref: payload.payment_ref,
        amount: payload.amount,
      },
      'subscription payment not applicable',
    );
    const current = (await subscriptionById(client, row.id))!;
    return {
      body: callbackBody(current),
      conflict: CONFLICT_MESSAGES[decision.reason],
      events: [],
    };
  }

  await activatePaid(client, row.id, {
    paymentRef: payload.payment_ref,
    start: decision.period.start.toISOString(),
    end: decision.period.end.toISOString(),
    nowIso,
  });
  const updated = (await subscriptionById(client, row.id))!;
  const context = (await getLocationContext(client, updated.location_id, nowIso))!;
  const event = createEvent(
    'billing.subscription.activated',
    {
      tenant: { id: env.tenantId, name: context.tenant_name },
      location: { id: context.id, code: context.code },
      data: {
        admin_wa_phone: context.admin_wa_phone,
        subscription_id: updated.id,
        plan_code: 'PAID_LOCATION',
        payment_ref: payload.payment_ref,
        current_period_start: decision.period.start.toISOString(),
        current_period_end: decision.period.end.toISOString(),
      },
    },
    { now: env.now },
  );
  return { body: callbackBody(updated), conflict: null, events: [event] };
}

/** Runs the callback in the payload's tenant transaction and publishes after the commit. */
export async function runSubscriptionCallback(
  deps: { pool: pg.Pool; events: EventPublisher; now: () => Date },
  payload: PaymentCallback,
  log: BillingLogger,
): Promise<{ body: SubscriptionCallbackBody; conflict: string | null }> {
  const outcome = await withTransaction(deps.pool, payload.tenant_id, (client) =>
    handleSubscriptionCallback(
      client,
      { tenantId: payload.tenant_id, now: deps.now(), log },
      payload,
    ),
  );
  await publishAll(deps.events, outcome.events, log);
  return { body: outcome.body, conflict: outcome.conflict };
}

export interface SubscriptionJobDeps {
  pool: pg.Pool;
  now: () => Date;
  log: BillingLogger;
}

/**
 * One pass of the subscription job (spec sections 6.1 and 6.3): expired checkouts go back to
 * ACTIVE, ended PAID_LOCATION periods fall back to FREE (the month's quota applies at once). Each
 * row runs in its own tenant transaction with conditional UPDATEs, so concurrent runs and
 * callbacks end in the same state. Returns the number of rows changed.
 */
export async function processDueSubscriptions(deps: SubscriptionJobDeps): Promise<number> {
  const due = await withTransaction(deps.pool, null, dueSubscriptions);
  let processed = 0;
  for (const row of due) {
    try {
      const nowIso = deps.now().toISOString();
      const changed = await withTransaction(deps.pool, row.tenant_id, async (client) => {
        const expired = await expirePendingIfDue(client, row.id, nowIso);
        const ended = await endPeriodIfDue(client, row.id, nowIso);
        return expired || ended;
      });
      if (changed) {
        processed += 1;
        deps.log.info({ subscription_id: row.id }, 'subscription job applied');
      }
    } catch (error) {
      // One failing row must not stop the others; the next run retries it.
      deps.log.error({ err: error, subscription_id: row.id }, 'subscription job row failed');
    }
  }
  return processed;
}
