// Request schemas (zod) and DTOs of the booking API and the payment callback (spec sections 7.2,
// 7.4, 8; FR-BOOKING-*). Request objects are strict: unknown keys are rejected.
import { z } from 'zod';

import { uuidSchema, waPhoneSchema } from './dto.js';
import type { BookingStatus, PaymentStatus } from './enums.js';
import { STAFF_BOOKING_ACTIONS } from './transitions.js';

export const SLOT_STATES = ['AVAILABLE', 'LOCKED', 'BOOKED'] as const;
export type SlotState = (typeof SLOT_STATES)[number];

/** Largest amount a numeric(12,2) column holds. */
export const MAX_PAYMENT_AMOUNT = 9999999999.99;

const localDateSchema = z.iso.date();
const customerNameSchema = z.string().trim().min(1).max(100);

export const availableSlotsQuerySchema = z.strictObject({
  location_id: uuidSchema,
  service_id: uuidSchema,
  date: localDateSchema,
});
export type AvailableSlotsQuery = z.infer<typeof availableSlotsQuerySchema>;

export const bookingCalendarQuerySchema = z.strictObject({
  location_id: uuidSchema,
  date: localDateSchema,
});
export type BookingCalendarQuery = z.infer<typeof bookingCalendarQuerySchema>;

export const activeBookingsQuerySchema = z.strictObject({
  location_id: uuidSchema,
  customer_phone: waPhoneSchema,
});
export type ActiveBookingsQuery = z.infer<typeof activeBookingsQuerySchema>;

/** The resource is chosen by the server, so the request carries no resource_id. */
export const createHoldRequestSchema = z.strictObject({
  location_id: uuidSchema,
  service_id: uuidSchema,
  slot_start: z.iso.datetime({ offset: true }),
  customer_name: customerNameSchema,
  customer_phone: waPhoneSchema,
});
export type CreateHoldRequest = z.infer<typeof createHoldRequestSchema>;

export const bookingActionRequestSchema = z.strictObject({
  action: z.enum(STAFF_BOOKING_ACTIONS),
});
export type BookingActionRequest = z.infer<typeof bookingActionRequestSchema>;

export const cancelBookingRequestSchema = z.strictObject({ customer_phone: waPhoneSchema });
export type CancelBookingRequest = z.infer<typeof cancelBookingRequestSchema>;

/** QRIS payment callback (spec section 7.4). */
export const paymentCallbackSchema = z.strictObject({
  payment_ref: z.string().min(1).max(64),
  tenant_id: uuidSchema,
  target_id: uuidSchema,
  amount: z.number().positive().max(MAX_PAYMENT_AMOUNT),
  status: z.string().min(1).max(32),
  paid_at: z.iso.datetime({ offset: true }).optional(),
});
export type PaymentCallback = z.infer<typeof paymentCallbackSchema>;

export interface BookingDto {
  id: string;
  location_id: string;
  service_id: string;
  service_name: string;
  resource_id: string;
  resource_name: string;
  customer_name: string;
  customer_phone: string;
  /** ISO 8601 UTC. */
  start_time: string;
  end_time: string;
  status: BookingStatus;
  payment_status: PaymentStatus;
  dp_amount: number | null;
  dp_paid: number | null;
  payment_ref: string | null;
  hold_expires_at: string | null;
  created_at: string;
}

export interface AvailableSlotsResponse {
  /** The requested local date, YYYY-MM-DD. */
  date: string;
  slot_interval_min: number;
  slots: { start_time: string; end_time: string }[];
}

export interface BookingCalendarCell {
  resource_id: string;
  resource_name: string;
  state: SlotState;
  booking: BookingDto | null;
}

export interface BookingCalendarResponse {
  date: string;
  slot_interval_min: number;
  slots: { start_time: string; end_time: string; resources: BookingCalendarCell[] }[];
}

export interface PaymentCallbackResponse {
  booking_id: string;
  status: BookingStatus;
  payment_status: PaymentStatus;
}

export interface ActiveBookingsResponse {
  bookings: BookingDto[];
}
