// SQL of the location subscription (spec sections 6.2, 6.3, 7.4). Every query runs as antre_app in
// a tenant transaction, so RLS limits it to the tenant of the request or callback payload.
import type { PlanCode } from '@antre/shared-types';
import type pg from 'pg';

import type { SubscriptionState } from './subscription.js';

export interface SubscriptionRow extends SubscriptionState {
  id: string;
  tenant_id: string;
  location_id: string;
  updated_at: Date;
}

const SUBSCRIPTION_COLUMNS = `s.id, s.tenant_id, s.location_id, s.plan_code, s.status,
  s.pending_plan_code, s.payment_ref, s.last_paid_ref, s.pending_expires_at,
  s.current_period_start, s.current_period_end, s.updated_at,
  pp.price_idr_per_month::float8 AS pending_price`;

/** `FOR UPDATE` locks the subscription row (callback, checkout, and job serialise on it). */
async function selectSubscription(
  client: pg.PoolClient,
  where: 's.id' | 's.location_id',
  value: string,
  forUpdate: boolean,
): Promise<SubscriptionRow | null> {
  const result = await client.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS}
     FROM subscriptions s LEFT JOIN plans pp ON pp.code = s.pending_plan_code
     WHERE ${where} = $1${forUpdate ? ' FOR UPDATE OF s' : ''}`,
    [value],
  );
  return result.rows[0] ?? null;
}

export function subscriptionById(
  client: pg.PoolClient,
  id: string,
  forUpdate = false,
): Promise<SubscriptionRow | null> {
  return selectSubscription(client, 's.id', id, forUpdate);
}

export function subscriptionByLocation(
  client: pg.PoolClient,
  locationId: string,
  forUpdate = false,
): Promise<SubscriptionRow | null> {
  return selectSubscription(client, 's.location_id', locationId, forUpdate);
}

export interface PlanRow {
  code: PlanCode;
  name: string;
  price_idr_per_month: number;
  monthly_ticket_quota: number | null;
}

export async function listPlans(client: pg.PoolClient): Promise<PlanRow[]> {
  const result = await client.query<PlanRow>(
    `SELECT code, name, price_idr_per_month::float8 AS price_idr_per_month, monthly_ticket_quota
     FROM plans ORDER BY price_idr_per_month, code`,
  );
  return result.rows;
}

export async function getPlan(client: pg.PoolClient, code: PlanCode): Promise<PlanRow | null> {
  const result = await client.query<PlanRow>(
    `SELECT code, name, price_idr_per_month::float8 AS price_idr_per_month, monthly_ticket_quota
     FROM plans WHERE code = $1`,
    [code],
  );
  return result.rows[0] ?? null;
}

/** PENDING_PAYMENT -> ACTIVE, plan unchanged (checkout expired, late or wrong-amount callback). */
export async function expirePending(
  client: pg.PoolClient,
  id: string,
  nowIso: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE subscriptions
     SET status = 'ACTIVE', pending_plan_code = NULL, pending_expires_at = NULL, updated_at = $2
     WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
    [id, nowIso],
  );
  return result.rowCount === 1;
}

/** The job's variant: only when the checkout is really past pending_expires_at. */
export async function expirePendingIfDue(
  client: pg.PoolClient,
  id: string,
  nowIso: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE subscriptions
     SET status = 'ACTIVE', pending_plan_code = NULL, pending_expires_at = NULL, updated_at = $2
     WHERE id = $1 AND status = 'PENDING_PAYMENT' AND pending_expires_at <= $2`,
    [id, nowIso],
  );
  return result.rowCount === 1;
}

/** PAID_LOCATION past current_period_end -> FREE without a period (spec section 6.3). */
export async function endPeriodIfDue(
  client: pg.PoolClient,
  id: string,
  nowIso: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE subscriptions
     SET plan_code = 'FREE', current_period_start = NULL, current_period_end = NULL, updated_at = $2
     WHERE id = $1 AND plan_code = 'PAID_LOCATION' AND current_period_end <= $2`,
    [id, nowIso],
  );
  return result.rowCount === 1;
}

export async function startCheckout(
  client: pg.PoolClient,
  id: string,
  input: { planCode: PlanCode; paymentRef: string; expiresAt: string; nowIso: string },
): Promise<void> {
  await client.query(
    `UPDATE subscriptions
     SET status = 'PENDING_PAYMENT', pending_plan_code = $2, payment_ref = $3,
         pending_expires_at = $4, updated_at = $5
     WHERE id = $1 AND status = 'ACTIVE'`,
    [id, input.planCode, input.paymentRef, input.expiresAt, input.nowIso],
  );
}

export async function activatePaid(
  client: pg.PoolClient,
  id: string,
  input: { paymentRef: string; start: string; end: string; nowIso: string },
): Promise<void> {
  await client.query(
    `UPDATE subscriptions
     SET status = 'ACTIVE', plan_code = pending_plan_code, pending_plan_code = NULL,
         pending_expires_at = NULL, last_paid_ref = $2, current_period_start = $3,
         current_period_end = $4, updated_at = $5
     WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
    [id, input.paymentRef, input.start, input.end, input.nowIso],
  );
}

export interface UsageRow {
  period_month: string;
  ticket_count: number;
}

/** The latest months of a location, newest first. */
export async function usageHistory(
  client: pg.PoolClient,
  locationId: string,
  limit: number,
): Promise<UsageRow[]> {
  const result = await client.query<UsageRow>(
    `SELECT period_month::text AS period_month, ticket_count
     FROM usage_counters WHERE location_id = $1
     ORDER BY period_month DESC LIMIT $2`,
    [locationId, limit],
  );
  return result.rows;
}

/** Candidates of the subscription job across tenants (database clock, spec section 6.1). */
export async function dueSubscriptions(
  client: pg.PoolClient,
): Promise<{ tenant_id: string; id: string }[]> {
  const result = await client.query<{ tenant_id: string; id: string }>(
    'SELECT tenant_id, id FROM app_due_subscriptions()',
  );
  return result.rows;
}
