// Enums mirror the CHECK constraints of packages/db/migrations (core-schema.sql, definer-functions.sql).
// Plain `as const` arrays plus derived union types; no TypeScript `enum`.

export const USER_ROLES = ['OWNER', 'STAFF_CALLER', 'STAFF_CASHIER', 'SUPER_ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const STAFF_ROLES = ['STAFF_CALLER', 'STAFF_CASHIER'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const TENANT_ROLES = ['OWNER', ...STAFF_ROLES] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

// Roles a token may carry (FR-AUTH-02). KIOSK_DISPLAY and SYSTEM_WA_CHANNEL are not issued yet.
export const TOKEN_ROLES = [...USER_ROLES, 'KIOSK_DISPLAY', 'SYSTEM_WA_CHANNEL'] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

export const BUSINESS_TYPES = ['CLINIC', 'SPORTS', 'BARBERSHOP', 'OTHER'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const SERVICE_MODES = ['WALK_IN', 'RESERVATION', 'BOTH'] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export const LOCATION_TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] as const;
export type LocationTimezone = (typeof LOCATION_TIMEZONES)[number];

export const TICKET_STATUSES = [
  'WAITING',
  'CALLED',
  'SERVING',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
  'EXPIRED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const ACTIVE_TICKET_STATUSES = ['WAITING', 'CALLED', 'SERVING'] as const;
export type ActiveTicketStatus = (typeof ACTIVE_TICKET_STATUSES)[number];

export const TICKET_CHANNELS = ['WHATSAPP', 'STAFF'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const BOOKING_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
  'EXPIRED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const ACTIVE_BOOKING_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED'] as const;
export type ActiveBookingStatus = (typeof ACTIVE_BOOKING_STATUSES)[number];

export const PAYMENT_STATUSES = ['NOT_REQUIRED', 'UNPAID', 'PAID', 'REFUND_PENDING'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'PENDING_PAYMENT'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PLAN_CODES = ['FREE', 'PAID_LOCATION'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const DELIVERY_STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'DLQ'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// Statuses a WhatsApp delivery callback may report (app_wa_update_delivery_status).
export const WA_DELIVERY_UPDATES = ['SENT', 'DELIVERED', 'READ', 'FAILED'] as const;
export type WaDeliveryUpdate = (typeof WA_DELIVERY_UPDATES)[number];
