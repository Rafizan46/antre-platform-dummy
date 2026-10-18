// Redis access of the gateway: one subscriber connection for the rt:{tenant}:{location} channels
// and one command connection for the update log (replay, snapshot) and the kiosk revocations.
// Commands fail fast while Redis is down (no offline queue, timeout); `ready` is false then, which
// makes /readyz answer 503, new streams 503, and the broadcaster close the open streams.
import type { RealtimeUpdate } from '@antre/messaging/realtime';
import { createClient } from '@redis/client';

import type { Logger } from './logger.js';

export interface LogEntry {
  id: string;
  update: RealtimeUpdate;
}

export interface RealtimeStore {
  readonly ready: boolean;
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  /** Up to `count` entries after `afterId` (exclusive), oldest first. */
  entriesAfter(logKey: string, afterId: string, count: number): Promise<LogEntry[]>;
  /** The oldest entry id still in the log, or null when the log is empty. */
  oldestId(logKey: string): Promise<string | null>;
  /** The newest `count` entries, oldest first. */
  latest(logKey: string, count: number): Promise<LogEntry[]>;
  /** Revocation instant (epoch ms) of the kiosk tokens of a location, or null. */
  kioskRevokedAt(key: string): Promise<number | null>;
  /** Called with the new value whenever `ready` changes. */
  onAvailability(listener: (ready: boolean) => void): void;
}

export class StoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreUnavailableError';
  }
}

type RawEntry = [string, string[]];

function parseEntries(reply: unknown): LogEntry[] {
  if (!Array.isArray(reply)) return [];
  const entries: LogEntry[] = [];
  for (const raw of reply as RawEntry[]) {
    const [id, fields] = raw;
    const index = fields.indexOf('u');
    if (index < 0 || index + 1 >= fields.length) continue;
    try {
      entries.push({ id, update: JSON.parse(fields[index + 1]!) as RealtimeUpdate });
    } catch {
      // A malformed entry is skipped; producers always write JSON.
    }
  }
  return entries;
}

const CONNECT_TIMEOUT_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 5000;

export class RedisRealtimeStore implements RealtimeStore {
  private readonly commands: ReturnType<typeof createClient>;
  private readonly subscriber: ReturnType<typeof createClient>;
  private readonly commandTimeoutMs: number;
  private readonly listeners: ((ready: boolean) => void)[] = [];
  private lastReady = false;

  constructor(options: { url: string; log: Logger; commandTimeoutMs?: number }) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 1000;
    const socket = {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries: number) => Math.min((retries + 1) * 200, MAX_RECONNECT_DELAY_MS),
    };
    this.commands = createClient({ url: options.url, disableOfflineQueue: true, socket });
    // The subscriber keeps its offline queue so that an UNSUBSCRIBE during an outage is not lost;
    // the client resubscribes the remaining channels after a reconnect.
    this.subscriber = createClient({ url: options.url, socket });
    for (const [name, client] of [
      ['commands', this.commands],
      ['subscriber', this.subscriber],
    ] as const) {
      client.on('error', (error: unknown) => {
        options.log.warn({ err: error, connection: name }, 'redis error');
        this.check();
      });
      client.on('ready', () => this.check());
      client.on('reconnecting', () => this.check());
      client.on('end', () => this.check());
    }
  }

  get ready(): boolean {
    return this.commands.isReady && this.subscriber.isReady;
  }

  onAvailability(listener: (ready: boolean) => void): void {
    this.listeners.push(listener);
  }

  /** Starts both connections; never rejects (the clients keep reconnecting in the background). */
  start(log: Logger): void {
    for (const client of [this.commands, this.subscriber]) {
      client.connect().catch((error: unknown) => {
        log.warn({ err: error }, 'redis unavailable at start; retrying in the background');
      });
    }
  }

  async close(): Promise<void> {
    for (const client of [this.subscriber, this.commands]) {
      try {
        await this.withTimeout(client.close(), this.commandTimeoutMs * 2);
      } catch {
        client.destroy();
      }
    }
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    await this.withTimeout(this.subscriber.subscribe(channel, listener), this.commandTimeoutMs * 2);
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.subscriber.unsubscribe(channel);
  }

  async entriesAfter(logKey: string, afterId: string, count: number): Promise<LogEntry[]> {
    return parseEntries(
      await this.command(['XRANGE', logKey, `(${afterId}`, '+', 'COUNT', String(count)]),
    );
  }

  async oldestId(logKey: string): Promise<string | null> {
    const entries = (await this.command(['XRANGE', logKey, '-', '+', 'COUNT', '1'])) as
      RawEntry[] | null;
    return entries?.[0]?.[0] ?? null;
  }

  async latest(logKey: string, count: number): Promise<LogEntry[]> {
    if (count === 0) return [];
    const reply = await this.command(['XREVRANGE', logKey, '+', '-', 'COUNT', String(count)]);
    return parseEntries(reply).reverse();
  }

  async kioskRevokedAt(key: string): Promise<number | null> {
    const value = await this.command(['GET', key]);
    if (typeof value !== 'string') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private check(): void {
    const ready = this.ready;
    if (ready === this.lastReady) return;
    this.lastReady = ready;
    for (const listener of this.listeners) listener(ready);
  }

  private async command(args: string[]): Promise<unknown> {
    return this.withTimeout(this.commands.sendCommand(args), this.commandTimeoutMs);
  }

  private async withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StoreUnavailableError('Redis timed out')), timeoutMs);
    });
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
