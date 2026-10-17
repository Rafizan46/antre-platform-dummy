import { HEADERS } from '@antre/messaging';
import { describe, expect, it } from 'vitest';

import { decideRetry, describeFailure, readRetryCount } from './retry.js';
import { WhatsAppSendError } from './whatsapp/adapter.js';

const DELAYS = [5_000, 25_000, 125_000];

describe('retry policy', () => {
  it('retries a transient failure 3 times with exponential backoff, then dead-letters', () => {
    const failure = describeFailure(new WhatsAppSendError('unavailable', 'down'));
    expect(decideRetry(0, failure, DELAYS)).toEqual({
      action: 'retry',
      queue: 'notifications.wa.retry.1',
      delayMs: 5_000,
      retry: 1,
    });
    expect(decideRetry(1, failure, DELAYS)).toEqual({
      action: 'retry',
      queue: 'notifications.wa.retry.2',
      delayMs: 25_000,
      retry: 2,
    });
    expect(decideRetry(2, failure, DELAYS)).toEqual({
      action: 'retry',
      queue: 'notifications.wa.retry.3',
      delayMs: 125_000,
      retry: 3,
    });
    expect(decideRetry(3, failure, DELAYS)).toEqual({ action: 'dead-letter' });
  });

  it('retries rate limits and internal errors, but dead-letters a rejected request at once', () => {
    expect(describeFailure(new WhatsAppSendError('rate_limited', 'slow down')).retryable).toBe(
      true,
    );
    expect(describeFailure(new Error('connection terminated'))).toEqual({
      kind: 'internal',
      retryable: true,
      message: 'Error: connection terminated',
    });
    const rejected = describeFailure(new WhatsAppSendError('rejected', 'bad recipient'));
    expect(rejected.retryable).toBe(false);
    expect(decideRetry(0, rejected, DELAYS)).toEqual({ action: 'dead-letter' });
  });

  it('reads the retry header defensively', () => {
    expect(readRetryCount(undefined)).toBe(0);
    expect(readRetryCount({})).toBe(0);
    expect(readRetryCount({ [HEADERS.retry]: 2 })).toBe(2);
    expect(readRetryCount({ [HEADERS.retry]: '1' })).toBe(1);
    expect(readRetryCount({ [HEADERS.retry]: -1 })).toBe(0);
    expect(readRetryCount({ [HEADERS.retry]: 'x' })).toBe(0);
    expect(readRetryCount({ [HEADERS.retry]: 9 })).toBe(3);
  });
});
