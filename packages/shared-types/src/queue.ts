// Request schemas (zod) and DTOs of the queue API (spec section 8, FR-QUEUE-*).
// Request objects are strict: unknown keys are rejected.
import { z } from 'zod';

import { uuidSchema, waPhoneSchema } from './dto.js';
import { TICKET_STATUSES, type TicketChannel, type TicketStatus } from './enums.js';
import { STAFF_TICKET_ACTIONS } from './transitions.js';

const customerNameSchema = z.string().trim().min(1).max(100);

export const createStaffTicketRequestSchema = z.strictObject({
  location_id: uuidSchema,
  service_id: uuidSchema,
  customer_name: customerNameSchema,
  customer_phone: waPhoneSchema.optional(),
});
export type CreateStaffTicketRequest = z.infer<typeof createStaffTicketRequestSchema>;

export const createWaTicketRequestSchema = z.strictObject({
  location_id: uuidSchema,
  service_id: uuidSchema,
  customer_phone: waPhoneSchema,
  customer_name: customerNameSchema.default('Pelanggan'),
});
export type CreateWaTicketRequest = z.infer<typeof createWaTicketRequestSchema>;

export const callNextRequestSchema = z.strictObject({
  location_id: uuidSchema,
  resource_id: uuidSchema,
  service_id: uuidSchema,
});
export type CallNextRequest = z.infer<typeof callNextRequestSchema>;

export const ticketActionRequestSchema = z.strictObject({
  action: z.enum(STAFF_TICKET_ACTIONS),
});
export type TicketActionRequest = z.infer<typeof ticketActionRequestSchema>;

export const cancelTicketRequestSchema = z.strictObject({ customer_phone: waPhoneSchema });
export type CancelTicketRequest = z.infer<typeof cancelTicketRequestSchema>;

export const listTicketsQuerySchema = z.strictObject({
  location_id: uuidSchema,
  status: z.enum(TICKET_STATUSES).optional(),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

export const activeTicketQuerySchema = z.strictObject({
  location_id: uuidSchema,
  customer_phone: waPhoneSchema,
});
export type ActiveTicketQuery = z.infer<typeof activeTicketQuerySchema>;

export interface QueueTicketDto {
  id: string;
  location_id: string;
  service_id: string;
  service_name: string;
  resource_id: string | null;
  resource_name: string | null;
  /** Operating day of the location, YYYY-MM-DD. */
  service_date: string;
  ticket_number: string;
  channel: TicketChannel;
  customer_name: string;
  customer_phone: string | null;
  status: TicketStatus;
  recall_count: number;
  /** Number of WAITING tickets before this one; null for non-WAITING tickets on staff endpoints. */
  people_ahead: number | null;
  /** ISO 8601; null when not WAITING, or hidden (show_wait_estimate = false) on internal endpoints. */
  estimated_serve_time: string | null;
  called_at: string | null;
  serving_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface CallNextResponse {
  ticket: QueueTicketDto | null;
}

export interface ActiveTicketResponse {
  ticket: QueueTicketDto | null;
}

/** Ticket number such as A-001; the sequence is padded to 3 digits and grows beyond (A-1000). */
export function formatTicketNumber(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}
