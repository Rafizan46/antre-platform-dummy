// Background jobs of the booking service (spec section 7.2 auto-release, FR-BOOKING-05 reminder).
// The SECURITY DEFINER functions list the candidates across tenants (database clock); each row is
// then handled in its own tenant transaction with a conditional UPDATE, which is what makes the
// outcome exactly-once when several replicas run (D4). On top of that one runner per job holds a
// session advisory lock, so replicas do not even repeat the work.
import type { EventEnvelope } from '@antre/event-contracts';
import type pg from 'pg';

import { withTransaction } from '../db/transaction.js';
import type { EventPublisher } from '../events/publisher.js';
import { publishAll } from '../events/publisher.js';
import { getLocationContext } from '../queue/queries.js';
import {
  dueHolds,
  dueReminders,
  expireHoldIfDue,
  markReminderIfDue,
  selectBookingsByIds,
  type BookingRow,
} from './queries.js';
import {
  bookingEvent,
  bookingScope,
  type BookingEventKind,
  type BookingLogger,
} from './service.js';
import { slotLockKey, type SlotLock } from './slot-lock.js';

/** Advisory lock class of the background jobs (booking 1-2, billing 3). */
export const ADVISORY_LOCK_CLASS = 72070;
const EXPIRY_JOB_ID = 1;
const REMINDER_JOB_ID = 2;
const DEFAULT_INTERVAL_MS = 60_000;

export interface BookingJobDeps {
  pool: pg.Pool;
  slotLock: SlotLock;
  events: EventPublisher;
  now: () => Date;
  log: BookingLogger;
}

export interface JobResult {
  /** True when another runner holds the job's advisory lock. */
  skipped: boolean;
  processed: number;
}

/** Runs `work` only when this session gets the advisory lock of the job (shared with billing). */
export async function runAsLeader(
  deps: { pool: pg.Pool },
  jobId: number,
  work: () => Promise<number>,
): Promise<JobResult> {
  const client = await deps.pool.connect();
  let releaseError: Error | undefined;
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
      [ADVISORY_LOCK_CLASS, jobId],
    );
    if (lock.rows[0]?.locked !== true) return { skipped: true, processed: 0 };
    try {
      return { skipped: false, processed: await work() };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [
          ADVISORY_LOCK_CLASS,
          jobId,
        ]);
      } catch (error) {
        // The lock may still be held: drop the connection so the session (and lock) ends.
        releaseError = error instanceof Error ? error : new Error('advisory unlock failed');
      }
    }
  } finally {
    client.release(releaseError);
  }
}

interface Handled {
  events: EventEnvelope[];
  release: { key: string; token: string } | null;
}

/** Applies `change` to one due booking in its tenant transaction, then releases and publishes. */
async function handleDue(
  deps: BookingJobDeps,
  due: { tenant_id: string; id: string },
  change: (client: pg.PoolClient, nowIso: string) => Promise<boolean>,
  kind: BookingEventKind,
): Promise<boolean> {
  const now = deps.now();
  const handled = await withTransaction(
    deps.pool,
    due.tenant_id,
    async (client): Promise<Handled | null> => {
      if (!(await change(client, now.toISOString()))) return null;
      const row: BookingRow = (await selectBookingsByIds(client, [due.id]))[0]!;
      const context = (await getLocationContext(client, row.location_id, now.toISOString()))!;
      return {
        events: [bookingEvent(kind, bookingScope(due.tenant_id, context), row, now)],
        release: { key: slotLockKey(row.resource_id, row.start_time), token: row.hold_token },
      };
    },
  );
  if (handled === null) return false;

  if (kind === 'expired' && handled.release !== null) {
    try {
      await deps.slotLock.release(handled.release.key, handled.release.token);
    } catch (error) {
      deps.log.warn({ err: error, key: handled.release.key }, 'slot lock release failed');
    }
  }
  await publishAll(deps.events, handled.events, deps.log);
  return true;
}

async function processDue(
  deps: BookingJobDeps,
  list: (client: pg.PoolClient) => Promise<{ tenant_id: string; id: string }[]>,
  change: (id: string) => (client: pg.PoolClient, nowIso: string) => Promise<boolean>,
  kind: BookingEventKind,
): Promise<number> {
  const due = await withTransaction(deps.pool, null, list);
  let processed = 0;
  for (const row of due) {
    try {
      if (await handleDue(deps, row, change(row.id), kind)) processed += 1;
    } catch (error) {
      // One failing row must not stop the others; the next run retries it.
      deps.log.error({ err: error, booking_id: row.id, job: kind }, 'booking job row failed');
    }
  }
  return processed;
}

/** Expires holds whose 5 minutes are up and releases their locks (FR-BOOKING-04). */
export async function runExpiryJob(deps: BookingJobDeps): Promise<JobResult> {
  return runAsLeader(deps, EXPIRY_JOB_ID, () =>
    processDue(
      deps,
      dueHolds,
      (id) => (client, nowIso) => expireHoldIfDue(client, id, nowIso),
      'expired',
    ),
  );
}

/** Publishes `booking.reservation.reminder_due` once for bookings starting within 30 minutes. */
export async function runReminderJob(deps: BookingJobDeps): Promise<JobResult> {
  return runAsLeader(deps, REMINDER_JOB_ID, () =>
    processDue(
      deps,
      dueReminders,
      (id) => (client, nowIso) => markReminderIfDue(client, id, nowIso),
      'reminder_due',
    ),
  );
}

/** Runs both jobs every `intervalMs` without overlapping runs; `stop` waits for a running one. */
export function startBookingJobs(
  deps: BookingJobDeps,
  options: { intervalMs?: number } = {},
): { stop(): Promise<void> } {
  let running: Promise<void> | null = null;
  let stopped = false;

  const tick = (): void => {
    if (running !== null || stopped) return;
    running = (async () => {
      for (const job of [runExpiryJob, runReminderJob]) {
        try {
          await job(deps);
        } catch (error) {
          deps.log.error({ err: error }, 'booking job failed');
        }
      }
    })().finally(() => {
      running = null;
    });
  };
  const timer = setInterval(tick, options.intervalMs ?? DEFAULT_INTERVAL_MS);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
