// One SSE client. Wire format (text/event-stream):
//   retry: <ms>                      once, at the start
//   event: snapshot / id / data      {"updates":[...]} recent updates, oldest first (fresh connect,
//                                    or Last-Event-ID too old / too far behind)
//   event: update / id / data        one RealtimeUpdate (live or replayed after Last-Event-ID)
//   : ping                           heartbeat comment
// `id` is the Redis stream id of the update log, so EventSource resends it as Last-Event-ID.
// While the replay is read, live updates are buffered and flushed afterwards without duplicates.
// A client that does not drain its socket (buffer above the limit) is closed: it reconnects with
// Last-Event-ID and catches up from the log instead of growing the gateway's memory.
import { compareStreamIds, type RealtimeUpdate } from '@antre/messaging/realtime';

import type { LogEntry } from './store.js';

export interface SseSink {
  write(chunk: string): boolean;
  end(): void;
  readonly writableLength: number;
}

export type CloseReason =
  | 'client_closed'
  | 'slow_client'
  | 'expired'
  | 'kiosk_revoked'
  | 'redis_unavailable'
  | 'shutdown'
  | 'error';

export function sseEvent(event: string, data: unknown, id?: string): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MAX_PENDING = 1000;

export interface StreamIdentity {
  tenantId: string;
  locationId: string;
  kind: 'staff' | 'kiosk';
  /** KIOSK_DISPLAY: issue instant (epoch ms) for revocations. */
  kioskIssuedAtMs: number | null;
}

export class SseStream {
  readonly identity: StreamIdentity;
  private state: 'replaying' | 'live' | 'closed' = 'replaying';
  private lastId: string | null = null;
  private pending: LogEntry[] = [];
  private readonly closeListeners: ((reason: CloseReason) => void)[] = [];
  private readonly onSent: (event: string) => void;

  constructor(
    private readonly sink: SseSink,
    identity: StreamIdentity,
    private readonly maxBufferedBytes: number,
    onSent: (event: string) => void = () => undefined,
  ) {
    this.identity = identity;
    this.onSent = onSent;
  }

  get closed(): boolean {
    return this.state === 'closed';
  }

  onClose(listener: (reason: CloseReason) => void): void {
    this.closeListeners.push(listener);
  }

  open(retryMs: number): void {
    this.write(`retry: ${retryMs}\n\n`);
  }

  /** Recent updates for a client without usable Last-Event-ID. */
  sendSnapshot(entries: LogEntry[]): void {
    const last = entries.at(-1);
    if (last !== undefined) this.lastId = last.id;
    if (this.write(sseEvent('snapshot', { updates: entries.map((e) => e.update) }, last?.id))) {
      this.onSent('snapshot');
    }
  }

  /** Updates after Last-Event-ID, oldest first. */
  sendReplay(afterId: string, entries: LogEntry[]): void {
    this.lastId = afterId;
    for (const entry of entries) this.sendUpdate(entry.id, entry.update);
  }

  /** Ends the replay: buffered live updates newer than the last sent id are written. */
  goLive(): void {
    if (this.state !== 'replaying') return;
    this.state = 'live';
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) this.sendUpdate(entry.id, entry.update);
  }

  deliver(id: string, update: RealtimeUpdate): void {
    if (this.state === 'closed') return;
    if (this.state === 'replaying') {
      if (this.pending.length >= MAX_PENDING) {
        this.close('slow_client');
        return;
      }
      this.pending.push({ id, update });
      return;
    }
    this.sendUpdate(id, update);
  }

  heartbeat(): void {
    if (this.state !== 'closed') this.write(': ping\n\n');
  }

  close(reason: CloseReason): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.pending = [];
    try {
      this.sink.end();
    } catch {
      // The socket may already be gone.
    }
    for (const listener of this.closeListeners) listener(reason);
  }

  private sendUpdate(id: string, update: RealtimeUpdate): void {
    if (this.lastId !== null && compareStreamIds(id, this.lastId) <= 0) return;
    this.lastId = id;
    if (this.write(sseEvent('update', update, id))) this.onSent('update');
  }

  private write(chunk: string): boolean {
    if (this.state === 'closed') return false;
    try {
      this.sink.write(chunk);
    } catch {
      this.close('error');
      return false;
    }
    if (this.sink.writableLength > this.maxBufferedBytes) {
      this.close('slow_client');
      return false;
    }
    return true;
  }
}
