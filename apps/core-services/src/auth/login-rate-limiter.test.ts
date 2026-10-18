import { describe, expect, it } from 'vitest';

import { LoginRateLimiter } from './login-rate-limiter.js';

function setup(options: { maxEntries?: number } = {}) {
  let nowMs = Date.parse('2026-10-17T10:00:00Z');
  const limiter = new LoginRateLimiter({ now: () => new Date(nowMs), ...options });
  return {
    limiter,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('LoginRateLimiter', () => {
  it('blocks the sixth consecutive attempt', () => {
    const { limiter } = setup();
    for (let i = 1; i <= 5; i += 1) {
      expect(limiter.consume('k').blocked).toBe(false);
    }
    const sixth = limiter.consume('k');
    expect(sixth.blocked).toBe(true);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps keys independent', () => {
    const { limiter } = setup();
    for (let i = 0; i < 6; i += 1) limiter.consume('a');
    expect(limiter.consume('b').blocked).toBe(false);
  });

  it('reset clears the key', () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i += 1) limiter.consume('k');
    limiter.reset('k');
    expect(limiter.consume('k').blocked).toBe(false);
  });

  it('allows attempts again after the window', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 6; i += 1) limiter.consume('k');
    advance(15 * 60 * 1000 - 1000);
    expect(limiter.consume('k')).toEqual({ blocked: true, retryAfterSeconds: 1 });
    advance(1000);
    expect(limiter.consume('k').blocked).toBe(false);
  });

  it('prunes expired entries, then the oldest, when full', () => {
    const { limiter, advance } = setup({ maxEntries: 2 });
    for (let i = 0; i < 5; i += 1) limiter.consume('old');
    advance(1000);
    limiter.consume('second');
    // Full and nothing expired: the oldest entry ("old") is dropped, so it starts fresh.
    limiter.consume('third');
    expect(limiter.consume('old').blocked).toBe(false);
    // Expired entries are pruned first.
    advance(15 * 60 * 1000);
    limiter.consume('fourth');
    limiter.consume('fifth');
    expect(limiter.consume('fifth').blocked).toBe(false);
  });
});
