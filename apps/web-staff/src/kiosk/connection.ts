// SSE connection of the Kiosk TV (and later the dashboard) to the Realtime SSE Gateway, with
// automatic reconnect. EventSource reconnects by itself after a dropped stream (sending
// Last-Event-ID), but gives up for good on a non-200 answer (401, 429, 503); then this controller
// opens a new EventSource after a backoff (1 s, 2 s, 4 s, ... max 30 s), passing the last event id
// as ?last_event_id= because a new EventSource cannot set the header.
import type { RealtimeUpdate } from '@antre/messaging/realtime';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface ConnectionHandlers {
  onSnapshot(updates: RealtimeUpdate[]): void;
  onUpdate(update: RealtimeUpdate): void;
  onStatus(status: ConnectionStatus): void;
}

export interface ConnectionOptions {
  baseUrl: string;
  locationId: string;
  token: string;
  createEventSource?: (url: string) => EventSourceLike;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  maxBackoffMs?: number;
}

const CLOSED = 2;
const INITIAL_BACKOFF_MS = 1000;

export function streamUrl(
  baseUrl: string,
  locationId: string,
  token: string,
  lastEventId: string | null,
) {
  const params = new URLSearchParams({ access_token: token });
  if (lastEventId !== null) params.set('last_event_id', lastEventId);
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/realtime/locations/${encodeURIComponent(locationId)}/stream?${params.toString()}`;
}

export function backoffDelay(attempt: number, maxMs: number): number {
  return Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, maxMs);
}

export function connectRealtime(options: ConnectionOptions, handlers: ConnectionHandlers) {
  const create =
    options.createEventSource ?? ((url: string) => new EventSource(url) as EventSourceLike);
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;

  let source: EventSourceLike | null = null;
  let lastEventId: string | null = null;
  let attempt = 0;
  let timer: unknown = null;
  let stopped = false;

  const parse = <T>(event: MessageEvent<string>): T | null => {
    if (event.lastEventId) lastEventId = event.lastEventId;
    try {
      return JSON.parse(event.data) as T;
    } catch {
      return null;
    }
  };

  const open = (): void => {
    if (stopped) return;
    handlers.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const es = create(streamUrl(options.baseUrl, options.locationId, options.token, lastEventId));
    source = es;
    es.onopen = () => {
      attempt = 0;
      handlers.onStatus('open');
    };
    es.onerror = () => {
      if (stopped || source !== es) return;
      if (es.readyState === CLOSED) {
        es.close();
        source = null;
        const delay = backoffDelay(attempt, maxBackoffMs);
        attempt += 1;
        handlers.onStatus('reconnecting');
        timer = setTimer(open, delay);
      } else {
        handlers.onStatus('reconnecting');
      }
    };
    es.addEventListener('snapshot', (event) => {
      const data = parse<{ updates: RealtimeUpdate[] }>(event);
      if (data !== null) handlers.onSnapshot(data.updates);
    });
    es.addEventListener('update', (event) => {
      const update = parse<RealtimeUpdate>(event);
      if (update !== null) handlers.onUpdate(update);
    });
  };

  open();
  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      source?.close();
      source = null;
      handlers.onStatus('stopped');
    },
  };
}
