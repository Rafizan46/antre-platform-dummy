import { describe, expect, it } from 'vitest';

import {
  activeBookingsQuerySchema,
  availableSlotsQuerySchema,
  bookingActionRequestSchema,
  bookingCalendarQuerySchema,
  cancelBookingRequestSchema,
  createHoldRequestSchema,
  paymentCallbackSchema,
} from './index.js';

const id = '3f0c2a52-8b5e-4c1d-9a55-0d6f5c1b7e11';
const phone = '6281234567890';

describe('createHoldRequestSchema', () => {
  const base = {
    location_id: id,
    service_id: id,
    slot_start: '2026-10-19T03:00:00Z',
    customer_name: '  Budi ',
    customer_phone: phone,
  };

  it('accepts a valid request and trims the name', () => {
    expect(createHoldRequestSchema.parse(base).customer_name).toBe('Budi');
    expect(
      createHoldRequestSchema.safeParse({ ...base, slot_start: '2026-10-19T10:00:00+07:00' })
        .success,
    ).toBe(true);
  });

  it('rejects resource_id, unknown keys, and bad values', () => {
    expect(createHoldRequestSchema.safeParse({ ...base, resource_id: id }).success).toBe(false);
    expect(createHoldRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(createHoldRequestSchema.safeParse({ ...base, slot_start: '2026-10-19' }).success).toBe(
      false,
    );
    expect(createHoldRequestSchema.safeParse({ ...base, customer_phone: '0812' }).success).toBe(
      false,
    );
    expect(createHoldRequestSchema.safeParse({ ...base, customer_name: '   ' }).success).toBe(
      false,
    );
  });
});

describe('query schemas', () => {
  it('validate local dates and phones', () => {
    expect(
      availableSlotsQuerySchema.safeParse({ location_id: id, service_id: id, date: '2026-10-19' })
        .success,
    ).toBe(true);
    expect(
      availableSlotsQuerySchema.safeParse({ location_id: id, service_id: id, date: '19-10-2026' })
        .success,
    ).toBe(false);
    expect(
      bookingCalendarQuerySchema.safeParse({ location_id: id, date: '2026-02-30' }).success,
    ).toBe(false);
    expect(
      bookingCalendarQuerySchema.safeParse({ location_id: id, date: '2026-10-19', x: 1 }).success,
    ).toBe(false);
    expect(
      activeBookingsQuerySchema.safeParse({ location_id: id, customer_phone: phone }).success,
    ).toBe(true);
    expect(activeBookingsQuerySchema.safeParse({ location_id: id }).success).toBe(false);
  });
});

describe('action and cancel requests', () => {
  it('accept only staff booking actions', () => {
    for (const action of ['COMPLETE', 'NO_SHOW', 'CANCEL']) {
      expect(bookingActionRequestSchema.safeParse({ action }).success).toBe(true);
    }
    expect(bookingActionRequestSchema.safeParse({ action: 'EXPIRE' }).success).toBe(false);
    expect(bookingActionRequestSchema.safeParse({ action: 'CANCEL', extra: 1 }).success).toBe(
      false,
    );
    expect(cancelBookingRequestSchema.safeParse({ customer_phone: phone }).success).toBe(true);
    expect(cancelBookingRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('paymentCallbackSchema', () => {
  const base = {
    payment_ref: 'pay-abc',
    tenant_id: id,
    target_id: id,
    amount: 50000,
    status: 'PAID',
  };

  it('accepts a valid callback with or without paid_at', () => {
    expect(paymentCallbackSchema.safeParse(base).success).toBe(true);
    expect(
      paymentCallbackSchema.safeParse({ ...base, paid_at: '2026-10-19T03:01:00Z' }).success,
    ).toBe(true);
  });

  it('rejects bad amounts, empty fields, and unknown keys', () => {
    expect(paymentCallbackSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    expect(paymentCallbackSchema.safeParse({ ...base, amount: -1 }).success).toBe(false);
    expect(paymentCallbackSchema.safeParse({ ...base, amount: 9999999999.99 }).success).toBe(true);
    expect(paymentCallbackSchema.safeParse({ ...base, amount: 10000000000 }).success).toBe(false);
    expect(paymentCallbackSchema.safeParse({ ...base, payment_ref: '' }).success).toBe(false);
    expect(paymentCallbackSchema.safeParse({ ...base, payment_ref: 'x'.repeat(65) }).success).toBe(
      false,
    );
    expect(paymentCallbackSchema.safeParse({ ...base, tenant_id: 'nope' }).success).toBe(false);
    expect(paymentCallbackSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
