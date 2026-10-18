// Slot hold lock (spec section 7.2, FR-BOOKING-02). A hold takes `SET key hold_token NX PX 300000`
// before the booking row is inserted; the unique index `bookings_active_slot_key` stays the final
// guarantee, so a Redis outage degrades to the database check instead of failing holds (D1).
// Release is a compare-and-delete Lua script: a lock is never deleted with a plain DEL, because the
// key may already belong to a newer hold after this one expired.
import { createClient } from '@redis/client';

/** Lifetime of a hold and of its lock: 5 minutes (FR-BOOKING-04). */
export const HOLD_TTL_MS = 300_000;

const CONNECT_TIMEOUT_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 5000;

/** Lock key of a resource slot; the start is an ISO 8601 UTC instant with milliseconds. */
export function slotLockKey(resourceId: string, slotStart: Date): string {
  return `lock:slot:${resourceId}:${slotStart.toISOString()}`;
}

/** Redis could not answer (error, offline, or timeout); callers fall back to the database. */
export class SlotLockUnavailableError extends Error {
  constructor(message = 'Slot lock store is unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SlotLockUnavailableError';
  }
}

export interface SlotLock {
  /** SET NX PX: true when taken, false when someone else holds the key. */
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Compare-and-delete: true only when the key held `token` and was deleted. */
  release(key: string, token: string): Promise<boolean>;
  /** The subset of `keys` that currently exist (one MGET). */
  held(keys: string[]): Promise<Set<string>>;
}

/** KEYS[1] = lock key, ARGV[1] = hold_token. */
export const RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

interface WarnLogger {
  warn(object: object, message: string): void;
}

export interface RedisSlotLockOptions {
  url: string;
  commandTimeoutMs?: number;
  log: WarnLogger;
}

export class RedisSlotLock implements SlotLock {
  private readonly client: ReturnType<typeof createClient>;
  private readonly commandTimeoutMs: number;

  constructor(options: RedisSlotLockOptions) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 1000;
    this.client = createClient({
      url: options.url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectStrategy: (retries) => Math.min((retries + 1) * 200, MAX_RECONNECT_DELAY_MS),
      },
    });
    // Without a listener an 'error' event would crash the process.
    this.client.on('error', (error: unknown) => {
      options.log.warn({ err: error }, 'redis slot lock error');
    });
  }

  /**
   * Starts the connection. Rejects with SlotLockUnavailableError after `timeoutMs` when Redis is not
   * reachable; the client keeps reconnecting in the background, so a later start of Redis recovers.
   */
  async connect(timeoutMs = CONNECT_TIMEOUT_MS + 1000): Promise<void> {
    await this.withTimeout(
      this.client.connect().then(() => undefined),
      timeoutMs,
    );
  }

  async close(): Promise<void> {
    try {
      await this.withTimeout(this.client.close(), this.commandTimeoutMs * 2);
    } catch {
      this.client.destroy();
    }
  }

  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    const reply = await this.command<string | null>(['SET', key, token, 'NX', 'PX', String(ttlMs)]);
    return reply === 'OK';
  }

  async release(key: string, token: string): Promise<boolean> {
    const reply = await this.command<number>(['EVAL', RELEASE_SCRIPT, '1', key, token]);
    return reply === 1;
  }

  async held(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const values = await this.command<(string | null)[]>(['MGET', ...keys]);
    const present = new Set<string>();
    keys.forEach((key, index) => {
      if (values[index] !== null && values[index] !== undefined) present.add(key);
    });
    return present;
  }

  private async command<T>(args: string[]): Promise<T> {
    return this.withTimeout(this.client.sendCommand<T>(args), this.commandTimeoutMs);
  }

  /** Any failure, including the timeout, becomes SlotLockUnavailableError. */
  private async withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new SlotLockUnavailableError('Slot lock timed out')),
        timeoutMs,
      );
    });
    // The abandoned promise may still reject later; that must not become an unhandled rejection.
    pending.catch(() => {});
    try {
      return await Promise.race([pending, timeout]);
    } catch (error) {
      if (error instanceof SlotLockUnavailableError) throw error;
      throw new SlotLockUnavailableError('Slot lock command failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Same semantics as Redis (NX, TTL, compare-and-delete) for unit tests and non-booking tests. */
export class InMemorySlotLock implements SlotLock {
  private readonly entries = new Map<string, { token: string; expiresAt: number }>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private live(key: string): { token: string; expiresAt: number } | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (this.live(key) !== undefined) return false;
    this.entries.set(key, { token, expiresAt: this.now() + ttlMs });
    return true;
  }

  async release(key: string, token: string): Promise<boolean> {
    if (this.live(key)?.token !== token) return false;
    this.entries.delete(key);
    return true;
  }

  async held(keys: string[]): Promise<Set<string>> {
    return new Set(keys.filter((key) => this.live(key) !== undefined));
  }
}
