// Kiosk TV board state (FR-REALTIME-02): the number currently called at each counter (resource)
// and the recent calls, folded from the realtime updates of the location. Pure functions.
import type { RealtimeUpdate } from '@antre/messaging/realtime';

export interface Counter {
  resource: string;
  ticketId: string | null;
  ticketNumber: string;
  status: string;
  at: string;
}

export interface Call {
  ticketNumber: string;
  resource: string;
  isRecall: boolean;
  at: string;
}

export interface BoardState {
  /** Keyed by resource name, in order of first appearance. */
  counters: Counter[];
  /** Newest first. */
  recent: Call[];
}

export const RECENT_CALLS = 6;
const DONE = new Set(['COMPLETED', 'NO_SHOW', 'CANCELLED']);

export const emptyBoard: BoardState = { counters: [], recent: [] };

function upsert(counters: Counter[], counter: Counter): Counter[] {
  const index = counters.findIndex((c) => c.resource === counter.resource);
  if (index < 0) return [...counters, counter];
  return counters.map((c, i) => (i === index ? counter : c));
}

export function applyUpdate(state: BoardState, update: RealtimeUpdate): BoardState {
  switch (update.type) {
    case 'queue.ticket.called': {
      if (update.ticket_number === undefined || update.resource_name === undefined) return state;
      const call: Call = {
        ticketNumber: update.ticket_number,
        resource: update.resource_name,
        isRecall: update.is_recall === true,
        at: update.at,
      };
      return {
        counters: upsert(state.counters, {
          resource: update.resource_name,
          ticketId: update.ticket_id ?? null,
          ticketNumber: update.ticket_number,
          status: 'CALLED',
          at: update.at,
        }),
        recent: [call, ...state.recent].slice(0, RECENT_CALLS),
      };
    }
    case 'queue.ticket.serving':
    case 'queue.ticket.completed':
    case 'queue.ticket.no_show':
    case 'queue.ticket.cancelled': {
      const status = update.status;
      const counters = state.counters.map((c) =>
        c.ticketId !== null && c.ticketId === update.ticket_id && !DONE.has(c.status)
          ? { ...c, status }
          : c,
      );
      return { ...state, counters };
    }
    default:
      return state;
  }
}

export function applySnapshot(updates: RealtimeUpdate[]): BoardState {
  return updates.reduce(applyUpdate, emptyBoard);
}

/** A live update that must be announced (chime + TTS). */
export function isAnnouncement(update: RealtimeUpdate): boolean {
  return (
    update.type === 'queue.ticket.called' &&
    update.ticket_number !== undefined &&
    update.resource_name !== undefined
  );
}
