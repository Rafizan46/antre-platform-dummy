// Request schemas (zod) and DTOs of locations, operating hours, services, and resources
// (spec section 8, FR-CATALOG-*). Request objects are strict: unknown keys are rejected.
import { z } from 'zod';

import { locationCodeSchema, uuidSchema } from './dto.js';
import { LOCATION_TIMEZONES, type LocationTimezone } from './enums.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const timeSchema = z.string().regex(TIME_PATTERN);

const atLeastOneKey = { message: 'At least one field is required' };

const slotIntervalSchema = z.number().int().min(1).max(1440);

// Locations

export const createLocationRequestSchema = z.strictObject({
  code: locationCodeSchema,
  name: z.string().min(1).max(120),
  address: z.string().max(500).optional(),
  timezone: z.enum(LOCATION_TIMEZONES).default('Asia/Jakarta'),
  slot_interval_min: slotIntervalSchema.default(60),
});
export type CreateLocationRequest = z.infer<typeof createLocationRequestSchema>;

// The code never changes after creation.
export const updateLocationRequestSchema = z
  .strictObject({
    name: z.string().min(1).max(120).optional(),
    address: z.string().max(500).nullable().optional(),
    timezone: z.enum(LOCATION_TIMEZONES).optional(),
    slot_interval_min: slotIntervalSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, atLeastOneKey);
export type UpdateLocationRequest = z.infer<typeof updateLocationRequestSchema>;

export interface LocationDto {
  id: string;
  code: string;
  name: string;
  address: string | null;
  timezone: LocationTimezone;
  slot_interval_min: number;
  is_active: boolean;
}

// Operating hours

export const operatingDaySchema = z
  .strictObject({
    day_of_week: z.number().int().min(0).max(6),
    open_time: timeSchema,
    close_time: timeSchema,
    break_start: timeSchema.nullable().default(null),
    break_end: timeSchema.nullable().default(null),
  })
  .superRefine((day, ctx) => {
    // HH:MM strings compare correctly as text.
    if (day.open_time >= day.close_time) {
      ctx.addIssue({
        code: 'custom',
        path: ['close_time'],
        message: 'close_time must be after open_time',
      });
    }
    if ((day.break_start === null) !== (day.break_end === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['break_end'],
        message: 'break_start and break_end must be set together',
      });
      return;
    }
    if (
      day.break_start !== null &&
      day.break_end !== null &&
      (day.break_start < day.open_time ||
        day.break_start >= day.break_end ||
        day.break_end > day.close_time)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['break_start'],
        message: 'break must lie within opening hours and start before it ends',
      });
    }
  });
export type OperatingDayRequest = z.infer<typeof operatingDaySchema>;

export const putOperatingHoursRequestSchema = z
  .strictObject({
    slot_interval_min: slotIntervalSchema,
    days: z.array(operatingDaySchema).max(7),
  })
  .refine((value) => new Set(value.days.map((day) => day.day_of_week)).size === value.days.length, {
    message: 'day_of_week must be unique',
    path: ['days'],
  });
export type PutOperatingHoursRequest = z.infer<typeof putOperatingHoursRequestSchema>;

export interface OperatingDayDto {
  day_of_week: number;
  open_time: string;
  close_time: string;
  break_start: string | null;
  break_end: string | null;
}

export interface OperatingHoursDto {
  location_id: string;
  slot_interval_min: number;
  days: OperatingDayDto[];
}

// Services

const serviceFields = {
  name: z.string().min(1).max(120),
  ticket_prefix: z.string().regex(/^[A-Z]{1,3}$/),
  avg_duration_min: z.number().int().min(1).max(1440),
  price: z.number().int().min(0),
  requires_dp: z.boolean(),
  dp_amount: z.number().int().positive().nullable(),
  is_active: z.boolean(),
};

const dpConsistent = (value: { requires_dp?: boolean; dp_amount?: number | null }) =>
  value.requires_dp === (value.dp_amount !== null && value.dp_amount !== undefined);
const dpIssue = {
  message: 'requires_dp must be true exactly when dp_amount is set',
  path: ['dp_amount'],
};

export const createServiceRequestSchema = z
  .strictObject({
    name: serviceFields.name,
    ticket_prefix: serviceFields.ticket_prefix,
    avg_duration_min: serviceFields.avg_duration_min,
    price: serviceFields.price.default(0),
    requires_dp: serviceFields.requires_dp.default(false),
    dp_amount: serviceFields.dp_amount.default(null),
    is_active: serviceFields.is_active.default(true),
  })
  .refine(dpConsistent, dpIssue);
export type CreateServiceRequest = z.infer<typeof createServiceRequestSchema>;

export const updateServiceRequestSchema = z
  .strictObject({
    name: serviceFields.name.optional(),
    ticket_prefix: serviceFields.ticket_prefix.optional(),
    avg_duration_min: serviceFields.avg_duration_min.optional(),
    price: serviceFields.price.optional(),
    requires_dp: serviceFields.requires_dp.optional(),
    dp_amount: serviceFields.dp_amount.optional(),
    is_active: serviceFields.is_active.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, atLeastOneKey)
  .refine((value) => (value.requires_dp === undefined) === (value.dp_amount === undefined), {
    message: 'requires_dp and dp_amount must be sent together',
    path: ['dp_amount'],
  })
  .refine((value) => value.requires_dp === undefined || dpConsistent(value), dpIssue);
export type UpdateServiceRequest = z.infer<typeof updateServiceRequestSchema>;

export const internalServicesQuerySchema = z.strictObject({ location_id: uuidSchema.optional() });

export interface ServiceDto {
  id: string;
  name: string;
  ticket_prefix: string;
  avg_duration_min: number;
  price: number;
  requires_dp: boolean;
  dp_amount: number | null;
  is_active: boolean;
}

// Resources

const uniqueUuids = z
  .array(uuidSchema)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'service_ids must be unique' });

const resourceFields = {
  name: z.string().min(1).max(120),
  resource_type: z.string().max(60).nullable(),
  is_active: z.boolean(),
};

export const createResourceRequestSchema = z.strictObject({
  location_id: uuidSchema,
  name: resourceFields.name,
  resource_type: resourceFields.resource_type.default(null),
  is_active: resourceFields.is_active.default(true),
  service_ids: uniqueUuids.default([]),
});
export type CreateResourceRequest = z.infer<typeof createResourceRequestSchema>;

export const updateResourceRequestSchema = z
  .strictObject({
    name: resourceFields.name.optional(),
    resource_type: resourceFields.resource_type.optional(),
    is_active: resourceFields.is_active.optional(),
    service_ids: uniqueUuids.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, atLeastOneKey);
export type UpdateResourceRequest = z.infer<typeof updateResourceRequestSchema>;

export const listResourcesQuerySchema = z.strictObject({ location_id: uuidSchema.optional() });

export interface ResourceDto {
  id: string;
  location_id: string;
  name: string;
  resource_type: string | null;
  is_active: boolean;
  service_ids: string[];
}
