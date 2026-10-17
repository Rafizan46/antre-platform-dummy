// Monthly quota events shared by tickets and bookings (spec section 7.3, FR-BILLING-04). Both count
// against the same usage_counters row; the warning at 80 % and the exceeded notice are sent once per
// month.
import { createEvent, type EventEnvelope } from '@antre/event-contracts';
import type pg from 'pg';

import { markQuotaNotified, type QuotaUsage } from '../queue/queries.js';

const QUOTA_WARNING_RATIO = 0.8;

export interface QuotaEventInput {
  scope: {
    tenant: { id: string; name: string };
    location: { id: string; code: string };
  };
  adminWaPhone: string;
  locationId: string;
  periodMonth: string;
  quota: QuotaUsage;
  now: Date;
}

/** `billing.quota.warning` / `billing.quota.exceeded` for the count just reached; marks them sent. */
export async function quotaThresholdEvents(
  client: pg.PoolClient,
  input: QuotaEventInput,
): Promise<EventEnvelope[]> {
  const { quota, now } = input;
  if (quota.monthly_ticket_quota === null) return [];

  const events: EventEnvelope[] = [];
  const nowIso = now.toISOString();
  const quotaData = {
    admin_wa_phone: input.adminWaPhone,
    plan_code: 'FREE' as const,
    period_month: input.periodMonth,
    ticket_count: quota.ticket_count,
    monthly_ticket_quota: quota.monthly_ticket_quota,
  };
  if (
    quota.warning_sent_at === null &&
    quota.ticket_count >= Math.ceil(QUOTA_WARNING_RATIO * quota.monthly_ticket_quota)
  ) {
    await markQuotaNotified(client, 'warning', input.locationId, input.periodMonth, nowIso);
    events.push(createEvent('billing.quota.warning', { ...input.scope, data: quotaData }, { now }));
  }
  if (quota.exceeded_sent_at === null && quota.ticket_count >= quota.monthly_ticket_quota) {
    await markQuotaNotified(client, 'exceeded', input.locationId, input.periodMonth, nowIso);
    events.push(
      createEvent('billing.quota.exceeded', { ...input.scope, data: quotaData }, { now }),
    );
  }
  return events;
}

/**
 * Counts one CONFIRMED booking against the month (spec section 7.3). The quota was checked when the
 * slot was held, so this never refuses: a payment that arrives later must still confirm the booking.
 */
export async function incrementUsageUnconditional(
  client: pg.PoolClient,
  tenantId: string,
  locationId: string,
  periodMonth: string,
): Promise<QuotaUsage> {
  const result = await client.query<QuotaUsage>(
    `WITH uc AS (
       INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
       VALUES ($1, $2, $3::date, 1)
       ON CONFLICT (location_id, period_month)
       DO UPDATE SET ticket_count = usage_counters.ticket_count + 1
       RETURNING location_id, ticket_count, warning_sent_at, exceeded_sent_at)
     SELECT uc.ticket_count, p.code AS plan_code, p.monthly_ticket_quota,
            uc.warning_sent_at, uc.exceeded_sent_at
     FROM uc JOIN subscriptions s ON s.location_id = uc.location_id
     JOIN plans p ON p.code = s.plan_code`,
    [tenantId, locationId, periodMonth],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('location has no subscription');
  return row;
}
