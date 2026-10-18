// Response schemas of the endpoints the app depends on (built on the shared-types enums).
import {
  BOOKING_STATUSES,
  BUSINESS_TYPES,
  LOCATION_TIMEZONES,
  PAYMENT_STATUSES,
  PLAN_CODES,
  SERVICE_MODES,
  SUBSCRIPTION_STATUSES,
  TICKET_CHANNELS,
  TICKET_STATUSES,
  USER_ROLES,
  brandingSchema,
} from '@antre/shared-types';
import { z } from 'zod';

const nullableString = z.string().nullable();

export const loginResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    role: z.enum(USER_ROLES),
    tenant_id: nullableString,
  }),
});
export type LoginResult = z.infer<typeof loginResponseSchema>;

export const locationSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  address: nullableString,
  timezone: z.enum(LOCATION_TIMEZONES),
  slot_interval_min: z.number(),
  is_active: z.boolean(),
});
export type Location = z.infer<typeof locationSchema>;
export const locationsResponseSchema = z.object({ locations: z.array(locationSchema) });

export const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  ticket_prefix: z.string(),
  avg_duration_min: z.number(),
  price: z.number(),
  requires_dp: z.boolean(),
  dp_amount: z.number().nullable(),
  is_active: z.boolean(),
});
export type Service = z.infer<typeof serviceSchema>;
export const servicesResponseSchema = z.object({ services: z.array(serviceSchema) });

export const resourceSchema = z.object({
  id: z.string(),
  location_id: z.string(),
  name: z.string(),
  resource_type: nullableString,
  is_active: z.boolean(),
  service_ids: z.array(z.string()),
});
export type Resource = z.infer<typeof resourceSchema>;
export const resourcesResponseSchema = z.object({ resources: z.array(resourceSchema) });

export const operatingHoursSchema = z.object({
  location_id: z.string(),
  slot_interval_min: z.number(),
  days: z.array(
    z.object({
      day_of_week: z.number(),
      open_time: z.string(),
      close_time: z.string(),
      break_start: nullableString,
      break_end: nullableString,
    }),
  ),
});
export type OperatingHours = z.infer<typeof operatingHoursSchema>;

export const ticketSchema = z.object({
  id: z.string(),
  location_id: z.string(),
  service_id: z.string(),
  service_name: z.string(),
  resource_id: nullableString,
  resource_name: nullableString,
  ticket_number: z.string(),
  channel: z.enum(TICKET_CHANNELS),
  customer_name: z.string(),
  status: z.enum(TICKET_STATUSES),
  recall_count: z.number(),
  people_ahead: z.number().nullable(),
  called_at: nullableString,
  serving_at: nullableString,
  completed_at: nullableString,
  created_at: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;
export const ticketsResponseSchema = z.object({ tickets: z.array(ticketSchema) });
export const callNextResponseSchema = z.object({ ticket: ticketSchema.nullable() });

export const bookingSchema = z.object({
  id: z.string(),
  service_name: z.string(),
  resource_name: z.string(),
  customer_name: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  status: z.enum(BOOKING_STATUSES),
  payment_status: z.enum(PAYMENT_STATUSES),
});
export type Booking = z.infer<typeof bookingSchema>;
export const bookingCalendarSchema = z.object({
  date: z.string(),
  slots: z.array(z.object({ resources: z.array(z.object({ booking: bookingSchema.nullable() })) })),
});

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(USER_ROLES),
  is_active: z.boolean(),
  created_at: z.string(),
});
export type StaffUser = z.infer<typeof userSchema>;
export const usersResponseSchema = z.object({ users: z.array(userSchema) });

export const tenantSettingsSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  business_type: z.enum(BUSINESS_TYPES),
  service_mode: z.enum(SERVICE_MODES),
  show_wait_estimate: z.boolean(),
  admin_wa_phone: z.string(),
  branding: brandingSchema,
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const kioskTokenSchema = z.object({
  token: z.string(),
  token_id: z.string(),
  location_id: z.string(),
  expires_at: z.string(),
});
export type KioskToken = z.infer<typeof kioskTokenSchema>;

const subscriptionSchema = z.object({
  plan_code: z.enum(PLAN_CODES),
  status: z.enum(SUBSCRIPTION_STATUSES),
  pending_payment_ref: nullableString,
  pending_expires_at: nullableString,
  current_period_end: nullableString,
});
const usageSchema = z.object({
  period_month: z.string(),
  ticket_count: z.number(),
  monthly_ticket_quota: z.number().nullable(),
  remaining: z.number().nullable(),
  percent_used: z.number().nullable(),
  exhausted: z.boolean(),
});
export const billingOverviewSchema = z.object({
  subscription: subscriptionSchema,
  usage: usageSchema,
});
export type BillingOverview = z.infer<typeof billingOverviewSchema>;

export const checkoutSchema = z.object({
  subscription: subscriptionSchema,
  payment: z.object({
    payment_ref: z.string(),
    amount: z.number(),
    expires_at: z.string(),
    qris_payload: z.string(),
    instructions: z.string(),
  }),
});
export type Checkout = z.infer<typeof checkoutSchema>;
