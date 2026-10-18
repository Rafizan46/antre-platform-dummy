// State machines of spec section 6.3. A transition table maps an action to its allowed source
// statuses and its target status; next*Status returns null for an illegal move (INVALID_TRANSITION).
import type { BookingStatus, PaymentStatus, SubscriptionStatus, TicketStatus } from './enums.js';

interface Transition<Status extends string> {
  readonly from: readonly Status[];
  readonly to: Status;
}

function nextStatus<Action extends string, Status extends string>(
  table: Record<Action, Transition<Status>>,
  from: Status,
  action: Action,
): Status | null {
  const transition = table[action];
  return transition.from.includes(from) ? transition.to : null;
}

// Tickets

export const TICKET_ACTIONS = [
  'CALL_NEXT',
  'RECALL',
  'SERVE',
  'COMPLETE',
  'NO_SHOW',
  'CANCEL',
  'EXPIRE',
] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

export const TICKET_TRANSITIONS: Record<TicketAction, Transition<TicketStatus>> = {
  CALL_NEXT: { from: ['WAITING'], to: 'CALLED' },
  RECALL: { from: ['CALLED'], to: 'CALLED' },
  SERVE: { from: ['CALLED'], to: 'SERVING' },
  COMPLETE: { from: ['SERVING'], to: 'COMPLETED' },
  NO_SHOW: { from: ['CALLED'], to: 'NO_SHOW' },
  CANCEL: { from: ['WAITING'], to: 'CANCELLED' },
  EXPIRE: { from: ['WAITING', 'CALLED', 'SERVING'], to: 'EXPIRED' },
};

// Actions staff trigger per ticket (spec section 8).
export const STAFF_TICKET_ACTIONS = ['RECALL', 'SERVE', 'COMPLETE', 'NO_SHOW'] as const;

export const TERMINAL_TICKET_STATUSES = ['COMPLETED', 'NO_SHOW', 'CANCELLED', 'EXPIRED'] as const;

export function nextTicketStatus(from: TicketStatus, action: TicketAction): TicketStatus | null {
  return nextStatus(TICKET_TRANSITIONS, from, action);
}

// Bookings (status only). Time conditions (start_time, hold_expires_at) and payment callback
// rules stay with the Booking Service.

export const BOOKING_ACTIONS = [
  'CONFIRM_PAYMENT',
  'EXPIRE',
  'CANCEL',
  'COMPLETE',
  'NO_SHOW',
] as const;
export type BookingAction = (typeof BOOKING_ACTIONS)[number];

export const BOOKING_TRANSITIONS: Record<BookingAction, Transition<BookingStatus>> = {
  CONFIRM_PAYMENT: { from: ['PENDING_PAYMENT'], to: 'CONFIRMED' },
  EXPIRE: { from: ['PENDING_PAYMENT'], to: 'EXPIRED' },
  CANCEL: { from: ['PENDING_PAYMENT', 'CONFIRMED'], to: 'CANCELLED' },
  COMPLETE: { from: ['CONFIRMED'], to: 'COMPLETED' },
  NO_SHOW: { from: ['CONFIRMED'], to: 'NO_SHOW' },
};

export const STAFF_BOOKING_ACTIONS = ['COMPLETE', 'NO_SHOW', 'CANCEL'] as const;

export const TERMINAL_BOOKING_STATUSES = ['COMPLETED', 'NO_SHOW', 'CANCELLED', 'EXPIRED'] as const;

export function nextBookingStatus(
  from: BookingStatus,
  action: BookingAction,
): BookingStatus | null {
  return nextStatus(BOOKING_TRANSITIONS, from, action);
}

/** Cancelling a paid booking moves its payment to REFUND_PENDING (spec section 6.3); others stay. */
export function paymentStatusAfterCancel(paymentStatus: PaymentStatus): PaymentStatus {
  return paymentStatus === 'PAID' ? 'REFUND_PENDING' : paymentStatus;
}

// Subscriptions. The effect on plan_code (CHECKOUT and CONFIRM_PAYMENT lead to PAID_LOCATION,
// EXPIRE_PENDING and END_PERIOD fall back to FREE as the billing rules state) belongs to the
// Billing logic, not to this status table.

export const SUBSCRIPTION_ACTIONS = [
  'CHECKOUT',
  'CONFIRM_PAYMENT',
  'EXPIRE_PENDING',
  'END_PERIOD',
] as const;
export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number];

export const SUBSCRIPTION_TRANSITIONS: Record<
  SubscriptionAction,
  Transition<SubscriptionStatus>
> = {
  CHECKOUT: { from: ['ACTIVE'], to: 'PENDING_PAYMENT' },
  CONFIRM_PAYMENT: { from: ['PENDING_PAYMENT'], to: 'ACTIVE' },
  EXPIRE_PENDING: { from: ['PENDING_PAYMENT'], to: 'ACTIVE' },
  END_PERIOD: { from: ['ACTIVE'], to: 'ACTIVE' },
};

export function nextSubscriptionStatus(
  from: SubscriptionStatus,
  action: SubscriptionAction,
): SubscriptionStatus | null {
  return nextStatus(SUBSCRIPTION_TRANSITIONS, from, action);
}
