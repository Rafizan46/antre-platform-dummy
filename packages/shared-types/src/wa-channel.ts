// Request schemas (zod) and DTOs of the /internal/v1 endpoints that serve the WhatsApp Channel
// Service before or across tenants (spec sections 6.1, 8; FR-WA-03, FR-WA-04, FR-WA-06): location
// resolution of the QR keyword, the WhatsApp context of a location, and the active items of a
// phone number. Added in S09; additive only.
import { z } from 'zod';

import { locationCodeSchema, slugSchema, waPhoneSchema } from './dto.js';
import type { LocationTimezone, ServiceMode } from './enums.js';

/** Keyword parts are matched case-insensitively (FR-WA-03), so they are lower-cased first. */
export const resolveLocationQuerySchema = z.strictObject({
  slug: z.string().trim().toLowerCase().pipe(slugSchema),
  code: z.string().trim().toLowerCase().pipe(locationCodeSchema),
});
export type ResolveLocationQuery = z.infer<typeof resolveLocationQuerySchema>;

export interface ResolveLocationResponse {
  tenant_id: string;
  location_id: string;
}

export interface WaContextDto {
  tenant: { id: string; name: string };
  location: {
    id: string;
    code: string;
    name: string;
    timezone: LocationTimezone;
    is_active: boolean;
  };
  service_mode: ServiceMode;
  show_wait_estimate: boolean;
  /** branding.wa_greeting and branding.labels.resource (FR-AUTH-04); null when not set. */
  branding: { wa_greeting: string | null; resource_label: string | null };
}

export const activeItemsQuerySchema = z.strictObject({ customer_phone: waPhoneSchema });
export type ActiveItemsQuery = z.infer<typeof activeItemsQuerySchema>;

export const ACTIVE_ITEM_KINDS = ['TICKET', 'BOOKING'] as const;
export type ActiveItemKind = (typeof ACTIVE_ITEM_KINDS)[number];

/** One row of app_find_active_by_phone (spec section 6.1). */
export interface ActiveItemDto {
  kind: ActiveItemKind;
  tenant_id: string;
  location_id: string;
  item_id: string;
}

export interface ActiveItemsResponse {
  items: ActiveItemDto[];
}
