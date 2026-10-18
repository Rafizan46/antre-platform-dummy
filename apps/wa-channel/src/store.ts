// Key-value seam over Redis for the WA Channel Service (spec section 5.1: sessions, dedup, rate
// limit). Keys used by the service:
//   wa:msg:{wamid}   webhook dedup, SET NX EX 86400 (FR-WA-02)
//   wa:proc:{wamid}  consumer idempotency: "processing" (short TTL) then "done" (24 h)
//   wa:conv:{phone}  conversation session, TTL 30 minutes since the last message (FR-WA-03)
//   wa:rl:{phone}    inbound messages in the current minute (FR-WA-08)
//   wa:lock:{phone}  one message of a number at a time (compare-and-delete release)
// Every Redis failure (error, offline, timeout) surfaces as StoreUnavailableError.
import { createClient } from '@redis/client';

export class StoreUnavailableError extends Error {
  constructor(message = 'Redis is unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreUnavailableError';
  }
}

export interface KeyValueStore {
  /** SET NX PX: true when the key was set (it did not exist). */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  /** SET PX. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Compare-and-delete: true only when the key held `value`. */
  deleteIfEquals(key: string, value: string): Promise<boolean>;
  /** INCR; the first increment of a window sets its expiry. Returns the new count. */
  increment(key: string, windowMs: number): Promise<number>;
}

/** KEYS[1] = key, ARGV[1] = expected value. */
const DELETE_IF_EQUALS_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

/** KEYS[1] = counter key, ARGV[1] = window in milliseconds. */
const INCREMENT_SCRIPT = `local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return count`;

const CONNECT_TIMEOUT_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 5_000;

interface WarnLogger {
  warn(object: object, message: string): void;
}

export class RedisStore implements KeyValueStore {
  private readonly client: ReturnType<typeof createClient>;
  private readonly commandTimeoutMs: number;

  constructor(options: { url: string; log: WarnLogger; commandTimeoutMs?: number }) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 1_000;
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
      options.log.warn({ err: error }, 'redis error');
    });
  }

  /** True while the client is connected and ready for commands (readiness). */
  get ready(): boolean {
    return this.client.isReady;
  }

  /**
   * Starts the connection. Rejects after `timeoutMs` when Redis is not reachable; the client keeps
   * reconnecting in the background, so a later start of Redis recovers.
   */
  async connect(timeoutMs = CONNECT_TIMEOUT_MS + 1_000): Promise<void> {
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

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    const reply = await this.command<string | null>(['SET', key, value, 'NX', 'PX', String(ttlMs)]);
    return reply === 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.command<string | null>(['GET', key]);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.command<string>(['SET', key, value, 'PX', String(ttlMs)]);
  }

  async delete(key: string): Promise<void> {
    await this.command<number>(['DEL', key]);
  }

  async deleteIfEquals(key: string, value: string): Promise<boolean> {
    const reply = await this.command<number>(['EVAL', DELETE_IF_EQUALS_SCRIPT, '1', key, value]);
    return reply === 1;
  }

  async increment(key: string, windowMs: number): Promise<number> {
    return this.command<number>(['EVAL', INCREMENT_SCRIPT, '1', key, String(windowMs)]);
  }

  private async command<T>(args: string[]): Promise<T> {
    return this.withTimeout(this.client.sendCommand<T>(args), this.commandTimeoutMs);
  }

  private async withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StoreUnavailableError('Redis timed out')), timeoutMs);
    });
    // The abandoned promise may still reject later; that must not become an unhandled rejection.
    pending.catch(() => {});
    try {
      return await Promise.race([pending, timeout]);
    } catch (error) {
      if (error instanceof StoreUnavailableError) throw error;
      throw new StoreUnavailableError('Redis command failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Same semantics as RedisStore (NX, TTL, compare-and-delete) for unit tests. */
export class InMemoryStore implements KeyValueStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly now: () => number;
  /** Set to make every command fail (Redis outage in tests). */
  failing = false;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private check(): void {
    if (this.failing) throw new StoreUnavailableError('in-memory store failing');
  }

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Remaining lifetime of a key in milliseconds, or null when absent (tests). */
  ttl(key: string): number | null {
    const entry = this.live(key);
    return entry === undefined ? null : entry.expiresAt - this.now();
  }

  keys(): string[] {
    return [...this.entries.keys()].filter((key) => this.live(key) !== undefined);
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.check();
    if (this.live(key) !== undefined) return false;
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    return true;
  }

  async get(key: string): Promise<string | null> {
    this.check();
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.check();
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.check();
    this.entries.delete(key);
  }

  async deleteIfEquals(key: string, value: string): Promise<boolean> {
    this.check();
    if (this.live(key)?.value !== value) return false;
    this.entries.delete(key);
    return true;
  }

  async increment(key: string, windowMs: number): Promise<number> {
    this.check();
    const entry = this.live(key);
    if (entry === undefined) {
      this.entries.set(key, { value: '1', expiresAt: this.now() + windowMs });
      return 1;
    }
    const count = Number(entry.value) + 1;
    entry.value = String(count);
    return count;
  }
}

/** Redis keys of spec section 5.1 / FR-WA-02, FR-WA-03, FR-WA-08. */
export const KEYS = {
  webhookDedup: (wamid: string) => `wa:msg:${wamid}`,
  processed: (wamid: string) => `wa:proc:${wamid}`,
  session: (phone: string) => `wa:conv:${phone}`,
  rateLimit: (phone: string) => `wa:rl:${phone}`,
  phoneLock: (phone: string) => `wa:lock:${phone}`,
} as const;
