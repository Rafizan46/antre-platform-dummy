// Retry policy of FR-NOTIF-05: transient failures are retried 3 times with exponential backoff
// (spec section 7.1: 5 s, 25 s, 125 s) through the delay queues, then the message goes to the
// DLQ. Permanent failures (the request itself is rejected) go to the DLQ at once.
import { HEADERS, MAX_RETRIES, NOTIFICATIONS_RETRY_QUEUES } from '@antre/messaging';

import { WhatsAppSendError } from './whatsapp/adapter.js';

export type FailureKind = 'rate_limited' | 'unavailable' | 'rejected' | 'internal';

export interface Failure {
  kind: FailureKind;
  retryable: boolean;
  /** Short reason without personal data (stored in the DLQ headers). */
  message: string;
}

export function describeFailure(error: unknown): Failure {
  if (error instanceof WhatsAppSendError) {
    return { kind: error.kind, retryable: error.retryable, message: error.message.slice(0, 300) };
  }
  // Database or broker errors, or a bug: transient as far as we can tell, so retried.
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  return { kind: 'internal', retryable: true, message: message.slice(0, 300) };
}

export type RetryDecision =
  { action: 'retry'; queue: string; delayMs: number; retry: number } | { action: 'dead-letter' };

/** What to do after a failed attempt when `retriesDone` retries already happened. */
export function decideRetry(
  retriesDone: number,
  failure: Failure,
  delaysMs: readonly number[],
): RetryDecision {
  if (!failure.retryable || retriesDone >= MAX_RETRIES) return { action: 'dead-letter' };
  const queue = NOTIFICATIONS_RETRY_QUEUES[retriesDone]!;
  const delayMs = delaysMs[retriesDone] ?? delaysMs[delaysMs.length - 1] ?? 0;
  return { action: 'retry', queue, delayMs, retry: retriesDone + 1 };
}

/** Retries already done for a delivery (header set by the worker; absent = first attempt). */
export function readRetryCount(headers: Record<string, unknown> | undefined): number {
  const value = headers?.[HEADERS.retry];
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) return 0;
  return Math.min(number, MAX_RETRIES);
}
