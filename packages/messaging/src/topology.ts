// RabbitMQ topology of spec section 7.1. Every service that connects asserts the same topology
// (idempotent: same names, same arguments), so events published before the Notification Worker
// ever ran are still routed into notifications.wa instead of being dropped by the exchange.
//
//   antre.events (topic, durable)
//     -- NOTIFICATION_ROUTING_KEYS --> notifications.wa (durable; rejected -> notifications.dlq)
//     -- WA_INBOUND_ROUTING_KEYS --> wa.inbound (durable; rejected -> wa.inbound.dlq)
//   notifications.wa.retry.1|2|3 (durable, per-message TTL; expired -> notifications.wa)
//   wa.inbound.retry.1|2|3 (durable, per-message TTL; expired -> wa.inbound)
//   notifications.dlq, wa.inbound.dlq (durable, audit only)
//
// One delay queue per retry level: messages in one queue share the same delay, so the
// per-message TTL never blocks a shorter delay behind a longer one (RabbitMQ only expires
// messages at the head of a queue).
import { EVENT_EXCHANGE, type EventType } from '@antre/event-contracts';
import type { Channel } from 'amqplib';

export { EVENT_EXCHANGE };

export const NOTIFICATIONS_QUEUE = 'notifications.wa';
export const NOTIFICATIONS_DLQ = 'notifications.dlq';
export const NOTIFICATIONS_RETRY_QUEUES = [
  'notifications.wa.retry.1',
  'notifications.wa.retry.2',
  'notifications.wa.retry.3',
] as const;

/** Inbound WhatsApp messages for the conversation engine of the WA Channel Service (S09). */
export const WA_INBOUND_QUEUE = 'wa.inbound';
export const WA_INBOUND_DLQ = 'wa.inbound.dlq';
export const WA_INBOUND_RETRY_QUEUES = [
  'wa.inbound.retry.1',
  'wa.inbound.retry.2',
  'wa.inbound.retry.3',
] as const;
export const WA_INBOUND_ROUTING_KEYS = [
  'wa.message.received',
] as const satisfies readonly EventType[];

/** Retries after the first attempt (FR-NOTIF-05); the message goes to the DLQ afterwards. */
export const MAX_RETRIES = NOTIFICATIONS_RETRY_QUEUES.length;
/** Exponential backoff of spec section 7.1: 5 s, 25 s, 125 s. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 25_000, 125_000];

/** Routing keys whose consumer is notifications.wa in the event catalog (spec section 7.1). */
export const NOTIFICATION_ROUTING_KEYS = [
  'queue.ticket.created',
  'queue.ticket.near_turn',
  'queue.ticket.called',
  'booking.reservation.held',
  'booking.reservation.confirmed',
  'booking.reservation.expired',
  'booking.reservation.reminder_due',
  // S09: cancellation notice for every cause (customer BATAL, staff CANCEL, amount mismatch).
  'booking.reservation.cancelled',
  'billing.quota.warning',
  'billing.quota.exceeded',
  'billing.subscription.activated',
  'wa.status.received',
  'wa.reply.requested',
] as const satisfies readonly EventType[];
export type NotificationRoutingKey = (typeof NOTIFICATION_ROUTING_KEYS)[number];

/** Message headers set by a consumer when it moves a message to a retry queue or the DLQ. */
export const HEADERS = {
  /** Retries already done (0 on the first delivery). */
  retry: 'x-antre-retry',
  /** Routing key the event was originally published with. */
  routingKey: 'x-antre-routing-key',
  error: 'x-antre-error',
  errorKind: 'x-antre-error-kind',
  failedAt: 'x-antre-failed-at',
} as const;

/** A work queue with its delay queues, its DLQ, and its bindings on antre.events. */
async function assertWorkQueue(
  channel: Channel,
  queue: string,
  dlq: string,
  retryQueues: readonly string[],
  routingKeys: readonly string[],
): Promise<void> {
  await channel.assertQueue(dlq, { durable: true });
  // A rejected (nack without requeue) message, e.g. one that is not a valid event, is
  // dead-lettered straight to the DLQ by the broker.
  await channel.assertQueue(queue, {
    durable: true,
    deadLetterExchange: '',
    deadLetterRoutingKey: dlq,
  });
  for (const retryQueue of retryQueues) {
    // The consumer sets the delay as the per-message expiration; expired messages return to the
    // work queue through the default exchange (and RabbitMQ drops the expiration on the way).
    await channel.assertQueue(retryQueue, {
      durable: true,
      deadLetterExchange: '',
      deadLetterRoutingKey: queue,
    });
  }
  for (const routingKey of routingKeys) {
    await channel.bindQueue(queue, EVENT_EXCHANGE, routingKey);
  }
}

/** Asserts the exchange, queues, and bindings. Safe to call on every (re)connect. */
export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });
  await assertWorkQueue(
    channel,
    NOTIFICATIONS_QUEUE,
    NOTIFICATIONS_DLQ,
    NOTIFICATIONS_RETRY_QUEUES,
    NOTIFICATION_ROUTING_KEYS,
  );
  await assertWorkQueue(
    channel,
    WA_INBOUND_QUEUE,
    WA_INBOUND_DLQ,
    WA_INBOUND_RETRY_QUEUES,
    WA_INBOUND_ROUTING_KEYS,
  );
}
