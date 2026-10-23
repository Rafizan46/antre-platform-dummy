// Database access of the worker as antre_app (spec section 6.1 point 4): every write runs in a
// transaction with the tenant of the event set by set_config(..., true) (= SET LOCAL), so it ends
// with the transaction and never leaks to the next user of a pooled connection.
import { brandingSchema } from '@antre/shared-types';
import type pg from 'pg';

import type { NotificationContext } from './notifications.js';

export async function withTransaction<T>(
  pool: pg.Pool,
  tenantId: string | null,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // A checked-out client is not watched by the pool: a connection the server drops between two
  // queries must not become an uncaught exception. The next query rejects and the client is
  // released with an error, so the pool discards it.
  const ignoreClientError = (): void => undefined;
  client.on('error', ignoreClientError);
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
    }
    throw error;
  } finally {
    client.off('error', ignoreClientError);
    client.release(releaseError);
  }
}

/** Tenant name, branding, and location details for messages (RLS: own tenant only). */
export async function readContext(
  client: pg.PoolClient,
  locationId: string,
): Promise<NotificationContext | null> {
  const { rows } = await client.query<{
    tenant_name: string;
    branding: unknown;
    location_name: string;
    timezone: string;
  }>(
    `SELECT t.name AS tenant_name, t.branding, l.name AS location_name, l.timezone
     FROM locations l
     JOIN tenants t ON t.id = l.tenant_id
     WHERE l.id = $1`,
    [locationId],
  );
  const row = rows[0];
  if (!row) return null;
  const branding = brandingSchema.safeParse(row.branding);
  return {
    tenantName: row.tenant_name,
    greeting: branding.success ? (branding.data.wa_greeting ?? null) : null,
    resourceLabel: branding.success ? (branding.data.labels?.resource ?? null) : null,
    locationName: row.location_name,
    timeZone: row.timezone,
  };
}

export type LogStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'DLQ';

export interface LogRow {
  id: string;
  delivery_status: LogStatus;
  retry_count: number;
}

export interface NewLog {
  tenantId: string;
  eventId: string;
  recipientPhone: string;
  templateName: string | null;
  payload: unknown;
  retryCount: number;
}

/**
 * Creates the QUEUED log row of an event once (unique tenant_id + event_id) and locks it, so a
 * concurrent delivery of the same event waits here and then sees the outcome of the first one.
 */
export async function claimLog(client: pg.PoolClient, log: NewLog): Promise<LogRow> {
  await client.query(
    `INSERT INTO notification_logs
       (tenant_id, event_id, recipient_phone, template_name, payload, delivery_status, retry_count)
     VALUES ($1, $2, $3, $4, $5, 'QUEUED', $6)
     ON CONFLICT (tenant_id, event_id) DO NOTHING`,
    [
      log.tenantId,
      log.eventId,
      log.recipientPhone,
      log.templateName,
      JSON.stringify(log.payload),
      log.retryCount,
    ],
  );
  const { rows } = await client.query<LogRow>(
    `SELECT id, delivery_status, retry_count
     FROM notification_logs
     WHERE tenant_id = $1 AND event_id = $2
     FOR UPDATE`,
    [log.tenantId, log.eventId],
  );
  return rows[0]!;
}

export async function markSent(
  client: pg.PoolClient,
  id: string,
  providerMessageId: string,
  retryCount: number,
): Promise<void> {
  await client.query(
    `UPDATE notification_logs
     SET provider_message_id = $2, delivery_status = 'SENT', sent_at = now(), retry_count = $3
     WHERE id = $1`,
    [id, providerMessageId, retryCount],
  );
}

export async function markAttempt(
  client: pg.PoolClient,
  id: string,
  retryCount: number,
): Promise<void> {
  await client.query(
    `UPDATE notification_logs SET retry_count = $2 WHERE id = $1 AND delivery_status = 'QUEUED'`,
    [id, retryCount],
  );
}

/** Marks the log of an event that went to the DLQ (separate transaction, best effort). */
export async function markDeadLettered(
  pool: pg.Pool,
  tenantId: string,
  eventId: string,
  retryCount: number,
): Promise<void> {
  await withTransaction(pool, tenantId, async (client) => {
    await client.query(
      `UPDATE notification_logs SET delivery_status = 'DLQ', retry_count = $3
       WHERE tenant_id = $1 AND event_id = $2 AND delivery_status = 'QUEUED'`,
      [tenantId, eventId, retryCount],
    );
  });
}

/** wa.status.received through the SECURITY DEFINER function (no tenant context); rows updated. */
export async function updateDeliveryStatus(
  pool: pg.Pool,
  wamid: string,
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
  statusAt: string,
): Promise<number> {
  return withTransaction(pool, null, async (client) => {
    const { rows } = await client.query<{ updated: number }>(
      'SELECT app_wa_update_delivery_status($1, $2, $3) AS updated',
      [wamid, status, statusAt],
    );
    return rows[0]?.updated ?? 0;
  });
}
