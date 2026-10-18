// Request schemas (zod) and response types of the Tenant & Auth API (spec section 8, FR-AUTH-*).
// Request objects are strict: unknown keys are rejected with VALIDATION_ERROR.
import { z } from 'zod';

import {
  BUSINESS_TYPES,
  LOCATION_TIMEZONES,
  SERVICE_MODES,
  STAFF_ROLES,
  type BusinessType,
  type ServiceMode,
  type UserRole,
} from './enums.js';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const uuidSchema = z.uuid();
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const passwordSchema = z.string().min(8).max(128);
export const slugSchema = z.string().max(63).regex(SLUG_PATTERN);
export const locationCodeSchema = z.string().max(32).regex(SLUG_PATTERN);
export const waPhoneSchema = z.string().regex(/^[1-9][0-9]{7,14}$/);
export const accentColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const logoUrlSchema = z.url({ protocol: /^https$/ }).max(2048);

export const brandingSchema = z.strictObject({
  logo_url: logoUrlSchema.optional(),
  accent_color: accentColorSchema.optional(),
  labels: z
    .strictObject({
      resource: z.string().min(1).max(40).optional(),
      ticket: z.string().min(1).max(40).optional(),
    })
    .optional(),
  wa_greeting: z.string().trim().min(1).max(500).optional(),
});
export type Branding = z.infer<typeof brandingSchema>;

export const registerRequestSchema = z.strictObject({
  tenant: z.strictObject({
    name: z.string().min(1).max(120),
    slug: slugSchema,
    business_type: z.enum(BUSINESS_TYPES),
    admin_wa_phone: waPhoneSchema,
  }),
  location: z.strictObject({
    name: z.string().min(1).max(120),
    code: locationCodeSchema,
    address: z.string().max(500).optional(),
    timezone: z.enum(LOCATION_TIMEZONES).default('Asia/Jakarta'),
  }),
  owner: z.strictObject({
    email: emailSchema,
    password: passwordSchema,
  }),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

// Login does not enforce the minimum password length.
export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const createStaffRequestSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(STAFF_ROLES),
});
export type CreateStaffRequest = z.infer<typeof createStaffRequestSchema>;

export const updateStaffRequestSchema = z
  .strictObject({
    role: z.enum(STAFF_ROLES).optional(),
    password: passwordSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });
export type UpdateStaffRequest = z.infer<typeof updateStaffRequestSchema>;

export const updateTenantSettingsRequestSchema = z
  .strictObject({
    service_mode: z.enum(SERVICE_MODES).optional(),
    show_wait_estimate: z.boolean().optional(),
    admin_wa_phone: waPhoneSchema.optional(),
    // Replaces the whole branding object.
    branding: brandingSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });
export type UpdateTenantSettingsRequest = z.infer<typeof updateTenantSettingsRequestSchema>;

export interface UserDto {
  id: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  /** ISO 8601 timestamp. */
  created_at: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: { id: string; email: string; role: UserRole; tenant_id: string | null };
}

export interface RegisterResponse {
  tenant: { id: string; name: string; slug: string };
  location: { id: string; code: string; name: string };
  user: UserDto;
}

export interface TenantSettingsDto {
  id: string;
  name: string;
  slug: string;
  business_type: BusinessType;
  service_mode: ServiceMode;
  show_wait_estimate: boolean;
  admin_wa_phone: string;
  branding: Branding;
}

export interface AccessTokenClaims {
  sub: string;
  tenant_id: string | null;
  role: UserRole;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}
