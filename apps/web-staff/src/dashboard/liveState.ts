// Live dashboard state: folds realtime updates into the ticket list and computes the daily
// metrics. Pure functions. An update carries the new status but not the customer details, so an
// unknown ticket (created elsewhere) or a booking event asks for a refetch via needsRefresh.
import type { RealtimeUpdate } from '@antre/messaging/realtime';
import { TICKET_STATUSES, type TicketStatus } from '@antre/shared-types';

import type { Ticket } from '../api/schemas';

export interface LiveResult {
  tickets: Ticket[];
  needsRefresh: boolean;
}

function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

export function applyUpdate(tickets: Ticket[], update: RealtimeUpdate): LiveResult {
  if (update.type.startsWith('booking.')) return { tickets, needsRefresh: true };
  if (update.type === 'queue.ticket.near_turn') return { tickets, needsRefresh: true };
  const known = tickets.find((ticket) => ticket.id === update.ticket_id);
  if (update.ticket_id === undefined || known === undefined || !isTicketStatus(update.status)) {
    return { tickets, needsRefresh: true };
  }
  const isCall = update.type === 'queue.ticket.called';
  const patched: Ticket = {
    ...known,
    status: update.status,
    resource_name: update.resource_name ?? known.resource_name,
    recall_count: isCall && update.is_recall === true ? known.recall_count + 1 : known.recall_count,
  };
  return {
    tickets: tickets.map((ticket) => (ticket.id === known.id ? patched : ticket)),
    // Times (called/serving/completed) and people_ahead come from the server.
    needsRefresh: true,
  };
}

export interface DailyMetrics {
  waiting: number;
  inProgress: number;
  completed: number;
  /** Average of serving_at -> completed_at in minutes; null without a completed ticket. */
  averageServiceMinutes: number | null;
}

export function computeMetrics(tickets: Ticket[]): DailyMetrics {
  let waiting = 0;
  let inProgress = 0;
  let completed = 0;
  let totalMs = 0;
  let measured = 0;
  for (const ticket of tickets) {
    if (ticket.status === 'WAITING') waiting += 1;
    else if (ticket.status === 'CALLED' || ticket.status === 'SERVING') inProgress += 1;
    else if (ticket.status === 'COMPLETED') {
      completed += 1;
      if (ticket.serving_at !== null && ticket.completed_at !== null) {
        const ms = Date.parse(ticket.completed_at) - Date.parse(ticket.serving_at);
        if (Number.isFinite(ms) && ms >= 0) {
          totalMs += ms;
          measured += 1;
        }
      }
    }
  }
  return {
    waiting,
    inProgress,
    completed,
    averageServiceMinutes: measured === 0 ? null : Math.round(totalMs / measured / 6000) / 10,
  };
}

const STATUS_ORDER: Record<TicketStatus, number> = {
  SERVING: 0,
  CALLED: 1,
  WAITING: 2,
  COMPLETED: 3,
  NO_SHOW: 4,
  CANCELLED: 5,
  EXPIRED: 6,
};

/** Groups by service (in order of first appearance), active tickets first, then by number. */
export function groupByService(
  tickets: Ticket[],
): { serviceId: string; serviceName: string; tickets: Ticket[] }[] {
  const groups = new Map<string, { serviceId: string; serviceName: string; tickets: Ticket[] }>();
  for (const ticket of tickets) {
    let group = groups.get(ticket.service_id);
    if (group === undefined) {
      group = { serviceId: ticket.service_id, serviceName: ticket.service_name, tickets: [] };
      groups.set(ticket.service_id, group);
    }
    group.tickets.push(ticket);
  }
  for (const group of groups.values()) {
    group.tickets.sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.ticket_number.localeCompare(b.ticket_number),
    );
  }
  return [...groups.values()];
}

/** Today's date (YYYY-MM-DD) in the time zone of the location. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
