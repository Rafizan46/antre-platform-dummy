// Subscription job (spec section 6.3, FR-BILLING-05): expires open checkouts and downgrades ended
// PAID_LOCATION periods to FREE. Like the booking jobs (S07) one replica at a time runs it under a
// session advisory lock; the conditional UPDATEs keep it exactly-once even without the lock.
import { runAsLeader, type JobResult } from '../booking/jobs.js';
import { processDueSubscriptions, type SubscriptionJobDeps } from './service.js';

const SUBSCRIPTION_JOB_ID = 3;
/**
 * The spec calls it a daily job; running it every 5 minutes changes nothing but how soon an ended
 * period or an expired checkout is cleaned up (the callback checks the deadlines itself).
 */
const DEFAULT_INTERVAL_MS = 5 * 60_000;

export function runSubscriptionJob(deps: SubscriptionJobDeps): Promise<JobResult> {
  return runAsLeader(deps, SUBSCRIPTION_JOB_ID, () => processDueSubscriptions(deps));
}

/** Runs the job every `intervalMs` without overlapping runs; `stop` waits for a running one. */
export function startBillingJobs(
  deps: SubscriptionJobDeps,
  options: { intervalMs?: number } = {},
): { stop(): Promise<void> } {
  let running: Promise<void> | null = null;
  let stopped = false;

  const tick = (): void => {
    if (running !== null || stopped) return;
    running = runSubscriptionJob(deps)
      .then(() => undefined)
      .catch((error: unknown) => {
        deps.log.error({ err: error }, 'subscription job failed');
      })
      .finally(() => {
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
