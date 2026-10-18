// Event catalog (spec section 7.1): the 20 routing keys and the v1 `data` payload of each.
// Payloads other than the two examples in the spec are proposals; the owning workstream
// (messaging, queue, booking) may revise them through a T2 gate while no publisher exists.
import { WA_DELIVERY_UPDATES, TICKET_CHANNELS, waPhoneSchema } from '@antre/shared-types';
import { z } from 'zod';

export const EVENT_TYPES = [
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
  'booking.reservation.reminder_due',
  'booking.reservation.cancelled',
  'booking.reservation.completed',
  'booking.reservation.no_show',
  'billing.quota.warning',
  'billing.quota.exceeded',
  'billing.subscription.activated',
  'wa.message.received',
  'wa.status.received',
  'wa.reply.requested',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const isoDateTime = z.iso.datetime();
const nonEmpty = z.string().min(1);

const ticketRef = {
  ticket_id: z.uuid(),
  ticket_number: z.string().regex(/^[A-Z]{1,3}-[0-9]{3,}$/),
  customer_name: nonEmpty,
  customer_phone: waPhoneSchema.nullable(),
};

const bookingRef = {
  booking_id: z.uuid(),
  customer_name: nonEmpty,
  customer_phone: waPhoneSchema,
  service_name: nonEmpty,
  resource_name: nonEmpty,
  start_time: isoDateTime,
  end_time: isoDateTime,
};

// Payment states a booking event may carry besides the one fixed by its routing key.
const settledPaymentStatus = z.enum(['NOT_REQUIRED', 'UNPAID', 'PAID', 'REFUND_PENDING']);

const waMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), body: z.string().min(1).max(4096) }),
  z.object({
    kind: z.literal('buttons'),
    body: z.string().min(1).max(1024),
    buttons: z
      .array(z.object({ id: z.string().min(1).max(256), title: z.string().min(1).max(20) }))
      .min(1)
      .max(3),
  }),
  z.object({
    kind: z.literal('list'),
    body: z.string().min(1).max(1024),
    button_text: z.string().min(1).max(20),
    rows: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          title: z.string().min(1).max(24),
          description: z.string().max(72).optional(),
        }),
      )
      .min(1)
      .max(10),
  }),
]);

export const eventDataSchemas = {
  'queue.ticket.created': z.object({
    ...ticketRef,
    status: z.literal('WAITING'),
    channel: z.enum(TICKET_CHANNELS),
    service_name: nonEmpty,
    people_ahead: z.number().int().min(0),
    // null = hidden (show_wait_estimate = false).
    estimated_serve_time: isoDateTime.nullable(),
  }),
  'queue.ticket.near_turn': z.object({
    ...ticketRef,
    status: z.literal('WAITING'),
    service_name: nonEmpty,
    people_ahead: z.number().int().min(0),
    estimated_serve_time: isoDateTime.nullable(),
  }),
  'queue.ticket.called': z.object({
    ...ticketRef,
    status: z.literal('CALLED'),
    is_recall: z.boolean(),
    resource_name: nonEmpty,
    called_at: isoDateTime,
  }),
  'queue.ticket.serving': z.object({
    ...ticketRef,
    status: z.literal('SERVING'),
    resource_name: nonEmpty,
    serving_at: isoDateTime,
  }),
  'queue.ticket.completed': z.object({
    ...ticketRef,
    status: z.literal('COMPLETED'),
    completed_at: isoDateTime,
  }),
  'queue.ticket.no_show': z.object({ ...ticketRef, status: z.literal('NO_SHOW') }),
  'queue.ticket.cancelled': z.object({ ...ticketRef, status: z.literal('CANCELLED') }),
  'booking.reservation.held': z.object({
    ...bookingRef,
    status: z.literal('PENDING_PAYMENT'),
    payment_status: z.literal('UNPAID'),
    dp_amount: z.number().positive(),
    payment_ref: nonEmpty,
    hold_expires_at: isoDateTime,
  }),
  'booking.reservation.confirmed': z.object({
    ...bookingRef,
    status: z.literal('CONFIRMED'),
    payment_status: z.enum(['NOT_REQUIRED', 'PAID']),
    dp_amount: z.number().nullable(),
  }),
  'booking.reservation.expired': z.object({
    ...bookingRef,
    status: z.literal('EXPIRED'),
    payment_status: settledPaymentStatus,
  }),
  'booking.reservation.reminder_due': z.object({
    ...bookingRef,
    status: z.literal('CONFIRMED'),
  }),
  'booking.reservation.cancelled': z.object({
    ...bookingRef,
    status: z.literal('CANCELLED'),
    payment_status: settledPaymentStatus,
  }),
  'booking.reservation.completed': z.object({
    ...bookingRef,
    status: z.literal('COMPLETED'),
  }),
  'booking.reservation.no_show': z.object({
    ...bookingRef,
    status: z.literal('NO_SHOW'),
  }),
  'billing.quota.warning': z.object({
    admin_wa_phone: waPhoneSchema,
    plan_code: z.literal('FREE'),
    period_month: z.string().regex(/^\d{4}-\d{2}-01$/),
    ticket_count: z.number().int().min(0),
    monthly_ticket_quota: z.number().int().positive(),
  }),
  'billing.quota.exceeded': z.object({
    admin_wa_phone: waPhoneSchema,
    plan_code: z.literal('FREE'),
    period_month: z.string().regex(/^\d{4}-\d{2}-01$/),
    ticket_count: z.number().int().min(0),
    monthly_ticket_quota: z.number().int().positive(),
  }),
  'billing.subscription.activated': z.object({
    admin_wa_phone: waPhoneSchema,
    subscription_id: z.uuid(),
    plan_code: z.literal('PAID_LOCATION'),
    payment_ref: nonEmpty,
    current_period_start: isoDateTime,
    current_period_end: isoDateTime,
  }),
  'wa.message.received': z.object({
    wamid: nonEmpty,
    from: waPhoneSchema,
    profile_name: z.string().nullable(),
    type: nonEmpty,
    text: z.string().nullable(),
    reply_id: z.string().nullable(),
  }),
  'wa.status.received': z.object({
    wamid: nonEmpty,
    status: z.enum(WA_DELIVERY_UPDATES),
    status_at: isoDateTime,
    recipient: waPhoneSchema,
  }),
  // Meta limits on lengths are a HYPOTHESIS, verified by the WhatsApp workstream (FR-WA-07).
  'wa.reply.requested': z.object({ to: waPhoneSchema, message: waMessage }),
} satisfies Record<EventType, z.ZodType>;

export type EventData<K extends EventType> = z.infer<(typeof eventDataSchemas)[K]>;
