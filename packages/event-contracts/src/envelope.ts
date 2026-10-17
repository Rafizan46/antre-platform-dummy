// Event envelope (spec section 7.1): one shared header around the per-routing-key payload.
// Event objects are non-strict: unknown keys are stripped so older consumers tolerate newer producers.
import { z } from 'zod';

import { eventDataSchemas, type EventData, type EventType } from './catalog.js';

export const EVENT_EXCHANGE = 'antre.events';
export const EVENT_SCHEMA_VERSION = 1;

export const tenantRefSchema = z.object({ id: z.uuid(), name: z.string().min(1) });
export const locationRefSchema = z.object({ id: z.uuid(), code: z.string().min(1) });

export function createEventId(): string {
  return `evt-${globalThis.crypto.randomUUID()}`;
}

const header = {
  event_id: z.string().regex(/^evt-[0-9a-f-]{8,36}$/),
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  timestamp: z.iso.datetime(),
};

// queue.*, booking.*, billing.*: tenant and location are always present.
function scopedEnvelope<K extends EventType>(type: K) {
  return z.object({
    ...header,
    event_type: z.literal(type),
    tenant: tenantRefSchema,
    location: locationRefSchema,
    data: eventDataSchemas[type],
  });
}

// wa.message.received, wa.status.received: published by the webhook before the tenant is known.
function unscopedEnvelope<K extends EventType>(type: K) {
  return z.object({
    ...header,
    event_type: z.literal(type),
    tenant: z.null(),
    location: z.null(),
    data: eventDataSchemas[type],
  });
}

// wa.reply.requested: either may be null; a location without a tenant is not allowed.
const replyRequestedEnvelope = z
  .object({
    ...header,
    event_type: z.literal('wa.reply.requested'),
    tenant: tenantRefSchema.nullable(),
    location: locationRefSchema.nullable(),
    data: eventDataSchemas['wa.reply.requested'],
  })
  .refine((event) => event.location === null || event.tenant !== null, {
    message: 'location requires tenant',
    path: ['tenant'],
  });

export const eventEnvelopeSchema = z.discriminatedUnion('event_type', [
  scopedEnvelope('queue.ticket.created'),
  scopedEnvelope('queue.ticket.near_turn'),
  scopedEnvelope('queue.ticket.called'),
  scopedEnvelope('queue.ticket.serving'),
  scopedEnvelope('queue.ticket.completed'),
  scopedEnvelope('queue.ticket.no_show'),
  scopedEnvelope('queue.ticket.cancelled'),
  scopedEnvelope('booking.reservation.held'),
  scopedEnvelope('booking.reservation.confirmed'),
  scopedEnvelope('booking.reservation.expired'),
  scopedEnvelope('booking.reservation.reminder_due'),
  scopedEnvelope('booking.reservation.cancelled'),
  scopedEnvelope('booking.reservation.completed'),
  scopedEnvelope('booking.reservation.no_show'),
  scopedEnvelope('billing.quota.warning'),
  scopedEnvelope('billing.quota.exceeded'),
  scopedEnvelope('billing.subscription.activated'),
  unscopedEnvelope('wa.message.received'),
  unscopedEnvelope('wa.status.received'),
  replyRequestedEnvelope,
]);

export type EventEnvelope<K extends EventType = EventType> = Extract<
  z.infer<typeof eventEnvelopeSchema>,
  { event_type: K }
>;

/** Validates an unknown value (for example a consumed message). Throws a ZodError. */
export function parseEvent(input: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(input);
}

export function safeParseEvent(input: unknown) {
  return eventEnvelopeSchema.safeParse(input);
}

export interface CreateEventScope<K extends EventType> {
  tenant: EventEnvelope<K>['tenant'];
  location: EventEnvelope<K>['location'];
  data: EventData<K>;
}

/** Builds an envelope and validates it, so a publisher cannot emit a contract violation. */
export function createEvent<K extends EventType>(
  type: K,
  scope: CreateEventScope<K>,
  options: { now?: Date; eventId?: string } = {},
): EventEnvelope<K> {
  const event = {
    event_id: options.eventId ?? createEventId(),
    event_type: type,
    schema_version: EVENT_SCHEMA_VERSION,
    timestamp: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tenant: scope.tenant,
    location: scope.location,
    data: scope.data,
  };
  return parseEvent(event) as EventEnvelope<K>;
}
