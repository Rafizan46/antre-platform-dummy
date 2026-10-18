import { describe, expect, it } from 'vitest';

import {
  BOOKING_STATUSES,
  BOOKING_TRANSITIONS,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_TRANSITIONS,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  nextBookingStatus,
  nextSubscriptionStatus,
  nextTicketStatus,
  paymentStatusAfterCancel,
  type BookingAction,
  type SubscriptionAction,
  type TicketAction,
} from './index.js';

describe('ticket transitions (spec 6.3)', () => {
  const legal: [TicketAction, string, string][] = [
    ['CALL_NEXT', 'WAITING', 'CALLED'],
    ['RECALL', 'CALLED', 'CALLED'],
    ['SERVE', 'CALLED', 'SERVING'],
    ['COMPLETE', 'SERVING', 'COMPLETED'],
    ['NO_SHOW', 'CALLED', 'NO_SHOW'],
    ['CANCEL', 'WAITING', 'CANCELLED'],
    ['EXPIRE', 'WAITING', 'EXPIRED'],
    ['EXPIRE', 'CALLED', 'EXPIRED'],
    ['EXPIRE', 'SERVING', 'EXPIRED'],
  ];

  it.each(legal)('%s from %s -> %s', (action, from, to) => {
    expect(nextTicketStatus(from as (typeof TICKET_STATUSES)[number], action)).toBe(to);
  });

  it('allows exactly the listed moves', () => {
    let count = 0;
    for (const action of Object.keys(TICKET_TRANSITIONS) as TicketAction[]) {
      for (const status of TICKET_STATUSES) {
        if (nextTicketStatus(status, action) !== null) count += 1;
      }
    }
    expect(count).toBe(legal.length);
  });

  it('rejects illegal moves', () => {
    expect(nextTicketStatus('WAITING', 'COMPLETE')).toBeNull();
    expect(nextTicketStatus('COMPLETED', 'CANCEL')).toBeNull();
    expect(nextTicketStatus('SERVING', 'CALL_NEXT')).toBeNull();
  });
});

describe('booking transitions (spec 6.3)', () => {
  const legal: [BookingAction, string, string][] = [
    ['CONFIRM_PAYMENT', 'PENDING_PAYMENT', 'CONFIRMED'],
    ['EXPIRE', 'PENDING_PAYMENT', 'EXPIRED'],
    ['CANCEL', 'PENDING_PAYMENT', 'CANCELLED'],
    ['CANCEL', 'CONFIRMED', 'CANCELLED'],
    ['COMPLETE', 'CONFIRMED', 'COMPLETED'],
    ['NO_SHOW', 'CONFIRMED', 'NO_SHOW'],
  ];

  it.each(legal)('%s from %s -> %s', (action, from, to) => {
    expect(nextBookingStatus(from as (typeof BOOKING_STATUSES)[number], action)).toBe(to);
  });

  it('allows exactly the listed moves', () => {
    let count = 0;
    for (const action of Object.keys(BOOKING_TRANSITIONS) as BookingAction[]) {
      for (const status of BOOKING_STATUSES) {
        if (nextBookingStatus(status, action) !== null) count += 1;
      }
    }
    expect(count).toBe(legal.length);
  });

  it('rejects illegal moves', () => {
    expect(nextBookingStatus('PENDING_PAYMENT', 'COMPLETE')).toBeNull();
    expect(nextBookingStatus('CANCELLED', 'CONFIRM_PAYMENT')).toBeNull();
  });

  it('moves a paid payment to REFUND_PENDING on cancel only', () => {
    expect(paymentStatusAfterCancel('PAID')).toBe('REFUND_PENDING');
    expect(paymentStatusAfterCancel('UNPAID')).toBe('UNPAID');
    expect(paymentStatusAfterCancel('NOT_REQUIRED')).toBe('NOT_REQUIRED');
  });
});

describe('subscription transitions (spec 6.3)', () => {
  const legal: [SubscriptionAction, string, string][] = [
    ['CHECKOUT', 'ACTIVE', 'PENDING_PAYMENT'],
    ['CONFIRM_PAYMENT', 'PENDING_PAYMENT', 'ACTIVE'],
    ['EXPIRE_PENDING', 'PENDING_PAYMENT', 'ACTIVE'],
    ['END_PERIOD', 'ACTIVE', 'ACTIVE'],
  ];

  it.each(legal)('%s from %s -> %s', (action, from, to) => {
    expect(nextSubscriptionStatus(from as (typeof SUBSCRIPTION_STATUSES)[number], action)).toBe(to);
  });

  it('allows exactly the listed moves', () => {
    let count = 0;
    for (const action of Object.keys(SUBSCRIPTION_TRANSITIONS) as SubscriptionAction[]) {
      for (const status of SUBSCRIPTION_STATUSES) {
        if (nextSubscriptionStatus(status, action) !== null) count += 1;
      }
    }
    expect(count).toBe(legal.length);
  });

  it('rejects illegal moves', () => {
    expect(nextSubscriptionStatus('PENDING_PAYMENT', 'CHECKOUT')).toBeNull();
    expect(nextSubscriptionStatus('ACTIVE', 'CONFIRM_PAYMENT')).toBeNull();
  });
});
