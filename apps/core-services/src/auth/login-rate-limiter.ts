// In-memory login attempt limiter (per process). Fixed window starting at the first attempt of a key.
// `consume` is synchronous on purpose: it counts the attempt before any await, so parallel
// requests cannot slip past the limit while earlier ones are still being verified.

export interface LimiterDecision {
  blocked: boolean;
  retryAfterSeconds: number;
}

interface Entry {
  count: number;
  windowStart: number;
}

export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(
    options: {
      maxAttempts?: number;
      windowMs?: number;
      maxEntries?: number;
      now?: () => Date;
    } = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Blocks when the window already holds `maxAttempts`; otherwise counts this attempt. */
  consume(key: string): LimiterDecision {
    const nowMs = this.now().getTime();
    const existing = this.entries.get(key);

    if (existing && nowMs - existing.windowStart < this.windowMs) {
      if (existing.count >= this.maxAttempts) {
        const retryAfterMs = existing.windowStart + this.windowMs - nowMs;
        return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      existing.count += 1;
      return { blocked: false, retryAfterSeconds: 0 };
    }

    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      this.makeRoom(nowMs);
    }
    this.entries.set(key, { count: 1, windowStart: nowMs });
    return { blocked: false, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private makeRoom(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.windowStart >= this.windowMs) {
        this.entries.delete(key);
      }
    }
    // Still full: drop the oldest entries (Map keeps insertion order).
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
