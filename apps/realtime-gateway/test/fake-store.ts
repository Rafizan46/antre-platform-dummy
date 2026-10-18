// In-memory RealtimeStore for the unit tests: Pub/Sub listeners, an update log with stream-like
// ids, kiosk revocations, and a switch for the availability.
import type { RealtimeUpdate } from '@antre/messaging/realtime';

import type { LogEntry, RealtimeStore } from '../src/store.js';

export class FakeStore implements RealtimeStore {
  ready = true;
  readonly listeners = new Map<string, (message: string) => void>();
  readonly logs = new Map<string, LogEntry[]>();
  readonly revoked = new Map<string, number>();
  readonly unsubscribed: string[] = [];
  failSubscribe = false;
  private seq = 0;
  private readonly availability: ((ready: boolean) => void)[] = [];

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    if (this.failSubscribe) throw new Error('subscribe failed');
    this.listeners.set(channel, listener);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.listeners.delete(channel);
    this.unsubscribed.push(channel);
  }

  async entriesAfter(logKey: string, afterId: string, count: number): Promise<LogEntry[]> {
    const after = Number(afterId.split('-')[0]);
    return (this.logs.get(logKey) ?? [])
      .filter((entry) => Number(entry.id.split('-')[0]) > after)
      .slice(0, count);
  }

  async oldestId(logKey: string): Promise<string | null> {
    return this.logs.get(logKey)?.[0]?.id ?? null;
  }

  async latest(logKey: string, count: number): Promise<LogEntry[]> {
    return count === 0 ? [] : (this.logs.get(logKey) ?? []).slice(-count);
  }

  async kioskRevokedAt(key: string): Promise<number | null> {
    return this.revoked.get(key) ?? null;
  }

  onAvailability(listener: (ready: boolean) => void): void {
    this.availability.push(listener);
  }

  setReady(ready: boolean): void {
    this.ready = ready;
    for (const listener of this.availability) listener(ready);
  }

  /** Appends to the log (unless `logged` is false) and publishes like the core services do. */
  publish(logKey: string, channel: string, update: RealtimeUpdate, logged = true): string {
    this.seq += 1;
    const id = `${this.seq}-0`;
    if (logged) this.logs.set(logKey, [...(this.logs.get(logKey) ?? []), { id, update }]);
    this.listeners.get(channel)?.(JSON.stringify({ id, update }));
    return id;
  }

  raw(channel: string, message: string): void {
    this.listeners.get(channel)?.(message);
  }
}
