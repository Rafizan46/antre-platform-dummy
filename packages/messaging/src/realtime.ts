// Realtime path (spec sections 3.6 and 5.1, S10): the core services publish a compact update of
// every queue.* and booking.reservation.* state change, after the commit, to Redis; the Realtime
// SSE Gateway fans it out to the dashboard and the Kiosk TV of the location.
//
// Per (tenant, location):
// - Pub/Sub channel `rt:{tenant_id}:{location_id}`: live updates and control messages.
// - Stream `rt:log:{tenant_id}:{location_id}` (XADD MAXLEN ~ 500, expires 24 h after the last
//   update): the update log behind the SSE `id`, Last-Event-ID replay, and the snapshot.
// - Key `rt:kiosk-revoked:{tenant_id}:{location_id}`: epoch milliseconds before which the
//   KIOSK_DISPLAY tokens of the location are revoked.
//
// Exported as "@antre/messaging/realtime" without runtime dependencies, so the browser (Kiosk TV)
// can use the types. Updates carry no personal data: no customer name or phone number, no
// payment reference; only an allowlist of fields is copied from the event payload.
import type { EventEnvelope } from '@antre/event-contracts';

export const REALTIME_UPDATE_TYPES = [
  'queue.ticket.created',
  'queue.ticket.near_turn',
  'queue.ticket.called',
  'queue.ticket.serving',
  'queue.ticket.completed',
  'queue.ticket.no_show',
  'queue.ticket.cancelled',
  'booking.reservation.held',
  'booking.reservation.confirmed',
  'booking.reservation.expired',
  'booking.reservation.cancelled',
  'booking.reservation.completed',
  'booking.reservation.no_show',
] as const;
export type RealtimeUpdateType = (typeof REALTIME_UPDATE_TYPES)[number];

/** One state change as the SSE clients see it (`event: update`). Version 1. */
export interface RealtimeUpdate {
  type: RealtimeUpdateType;
  event_id: string;
  /** Envelope timestamp (ISO 8601). */
  at: string;
  location_id: string;
  status: string;
  ticket_id?: string;
  ticket_number?: string;
  booking_id?: string;
  service_name?: string;
  resource_name?: string;
  is_recall?: boolean;
  people_ahead?: number;
  start_time?: string;
  end_time?: string;
}

/** Payload fields copied into an update; everything else (PII, payment data) is dropped. */
const COPIED_FIELDS = [
  'status',
  'ticket_id',
  'ticket_number',
  'booking_id',
  'service_name',
  'resource_name',
  'is_recall',
  'people_ahead',
  'start_time',
  'end_time',
] as const;

export const REALTIME_LOG_MAXLEN = 500;
export const REALTIME_LOG_TTL_MS = 24 * 60 * 60 * 1000;
/** KIOSK_DISPLAY tokens are valid for 30 days (FR-AUTH-02). */
export const KIOSK_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A revocation outlives every token it revokes. */
export const KIOSK_REVOCATION_TTL_SECONDS = KIOSK_TOKEN_TTL_SECONDS + 24 * 60 * 60;

export function realtimeChannel(tenantId: string, locationId: string): string {
  return `rt:${tenantId}:${locationId}`;
}

export function realtimeLogKey(tenantId: string, locationId: string): string {
  return `rt:log:${tenantId}:${locationId}`;
}

export function kioskRevokedKey(tenantId: string, locationId: string): string {
  return `rt:kiosk-revoked:${tenantId}:${locationId}`;
}

function isUpdateType(value: string): value is RealtimeUpdateType {
  return (REALTIME_UPDATE_TYPES as readonly string[]).includes(value);
}

/** The update of a domain event, or null for events without a realtime view (wa.*, billing.*). */
export function toRealtimeUpdate(event: EventEnvelope): RealtimeUpdate | null {
  if (!isUpdateType(event.event_type) || event.location === null) return null;
  const data = event.data as Record<string, unknown>;
  const update: Record<string, unknown> = {
    type: event.event_type,
    event_id: event.event_id,
    at: event.timestamp,
    location_id: event.location.id,
  };
  for (const field of COPIED_FIELDS) {
    const value = data[field];
    if (value !== undefined && value !== null) update[field] = value;
  }
  return update as unknown as RealtimeUpdate;
}

/**
 * KEYS[1] = log stream, KEYS[2] = channel (single Redis instance); ARGV[1] = update JSON,
 * ARGV[2] = MAXLEN, ARGV[3] = TTL in ms. Appends the update to the log and publishes
 * `{"id":<stream id>,"update":<update>}` atomically, so a subscriber and a replay agree on ids.
 */
export const PUBLISH_UPDATE_SCRIPT = `local id = redis.call("XADD", KEYS[1], "MAXLEN", "~", ARGV[2], "*", "u", ARGV[1])
redis.call("PEXPIRE", KEYS[1], ARGV[3])
redis.call("PUBLISH", KEYS[2], '{"id":"' .. id .. '","update":' .. ARGV[1] .. '}')
return id`;

export type RealtimeMessage =
  | { kind: 'update'; id: string; update: RealtimeUpdate }
  | { kind: 'kiosk_revoked'; revokedAt: number };

export function encodeKioskRevoked(revokedAt: number): string {
  return JSON.stringify({ control: 'kiosk_revoked', revoked_at: revokedAt });
}

const STREAM_ID = /^[0-9]+-[0-9]+$/;

/** Parses a Pub/Sub message; null for anything malformed. */
export function decodeRealtimeMessage(raw: string): RealtimeMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message.control === 'kiosk_revoked' && typeof message.revoked_at === 'number') {
    return { kind: 'kiosk_revoked', revokedAt: message.revoked_at };
  }
  const update = message.update as Record<string, unknown> | undefined;
  if (
    typeof message.id === 'string' &&
    STREAM_ID.test(message.id) &&
    typeof update === 'object' &&
    update !== null &&
    typeof update.type === 'string' &&
    isUpdateType(update.type)
  ) {
    return { kind: 'update', id: message.id, update: update as unknown as RealtimeUpdate };
  }
  return null;
}

/** Compares two Redis stream ids ("<ms>-<seq>"): negative, 0, or positive. */
export function compareStreamIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  const ms = BigInt(aMs) - BigInt(bMs);
  if (ms !== 0n) return ms < 0n ? -1 : 1;
  const seq = BigInt(aSeq) - BigInt(bSeq);
  return seq === 0n ? 0 : seq < 0n ? -1 : 1;
}

export function isStreamId(value: string): boolean {
  return STREAM_ID.test(value);
}
