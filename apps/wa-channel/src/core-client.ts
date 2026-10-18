// Client of the core services' /internal/v1 endpoints (spec section 8). The WA Channel Service
// has no database connection; everything it knows comes from here. Every call carries the static
// service token (Authorization: Bearer) and, except the two tenantless endpoints, the tenant in
// X-Antre-Tenant-Id. Errors:
//   - CoreApiError: an answered 4xx with the error body of section 8 (business outcome, e.g.
//     409 ACTIVE_TICKET_EXISTS); the conversation turns it into a reply.
//   - CoreUnavailableError: network error, timeout, 5xx, 401 (wrong token), or an unexpected
//     body; the inbound message is retried and finally dead-lettered.
import type { ActiveItemDto, ErrorCode, ResolveLocationResponse } from '@antre/shared-types';
import { z } from 'zod';

export class CoreApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CoreApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class CoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CoreUnavailableError';
  }
}

export interface CreateTicketInput {
  location_id: string;
  service_id: string;
  customer_phone: string;
  customer_name: string;
}

export interface CreateHoldInput {
  location_id: string;
  service_id: string;
  slot_start: string;
  customer_phone: string;
  customer_name: string;
}

// Response shapes, validated loosely (unknown keys are kept out by zod's default strip). Only the
// fields the conversation reads are required.
const uuid = z.uuid();
const iso = z.string().min(1);

const ticketSchema = z.object({
  id: uuid,
  location_id: uuid,
  service_id: uuid,
  service_name: z.string(),
  resource_name: z.string().nullable(),
  ticket_number: z.string(),
  customer_name: z.string(),
  customer_phone: z.string().nullable(),
  status: z.enum(['WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'EXPIRED']),
  people_ahead: z.number().int().nullable(),
  estimated_serve_time: iso.nullable(),
});

const bookingSchema = z.object({
  id: uuid,
  location_id: uuid,
  service_id: uuid,
  service_name: z.string(),
  resource_name: z.string(),
  customer_name: z.string(),
  customer_phone: z.string(),
  start_time: iso,
  end_time: iso,
  status: z.enum(['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'EXPIRED']),
  payment_status: z.enum(['NOT_REQUIRED', 'UNPAID', 'PAID', 'REFUND_PENDING']),
  dp_amount: z.number().nullable(),
  payment_ref: z.string().nullable(),
  hold_expires_at: iso.nullable(),
});

const serviceSchema = z.object({
  id: uuid,
  name: z.string(),
  ticket_prefix: z.string(),
  avg_duration_min: z.number(),
  price: z.number(),
  requires_dp: z.boolean(),
  dp_amount: z.number().nullable(),
  is_active: z.boolean(),
});

const waContextSchema = z.object({
  tenant: z.object({ id: uuid, name: z.string() }),
  location: z.object({
    id: uuid,
    code: z.string(),
    name: z.string(),
    timezone: z.enum(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']),
    is_active: z.boolean(),
  }),
  service_mode: z.enum(['WALK_IN', 'RESERVATION', 'BOTH']),
  show_wait_estimate: z.boolean(),
  branding: z.object({
    wa_greeting: z.string().nullable(),
    resource_label: z.string().nullable(),
  }),
});

/** The fields of the shared DTOs (QueueTicketDto, BookingDto, ...) the conversation reads. */
export type CoreTicket = z.infer<typeof ticketSchema>;
export type CoreBooking = z.infer<typeof bookingSchema>;
export type CoreService = z.infer<typeof serviceSchema>;
export type CoreWaContext = z.infer<typeof waContextSchema>;
export interface CoreSlots {
  date: string;
  slot_interval_min: number;
  slots: { start_time: string; end_time: string }[];
}

/** What the conversation engine needs from the core services (faked in unit tests). */
export interface CoreApi {
  /** null when the keyword names no active location (404). */
  resolveLocation(slug: string, code: string): Promise<ResolveLocationResponse | null>;
  waContext(tenantId: string, locationId: string): Promise<CoreWaContext>;
  listServices(tenantId: string, locationId: string): Promise<CoreService[]>;
  createTicket(tenantId: string, input: CreateTicketInput): Promise<CoreTicket>;
  activeTicket(tenantId: string, locationId: string, phone: string): Promise<CoreTicket | null>;
  cancelTicket(tenantId: string, ticketId: string, phone: string): Promise<CoreTicket>;
  availableSlots(
    tenantId: string,
    locationId: string,
    serviceId: string,
    date: string,
  ): Promise<CoreSlots>;
  createHold(tenantId: string, input: CreateHoldInput): Promise<CoreBooking>;
  activeBookings(tenantId: string, locationId: string, phone: string): Promise<CoreBooking[]>;
  cancelBooking(tenantId: string, bookingId: string, phone: string): Promise<CoreBooking>;
  activeItems(phone: string): Promise<ActiveItemDto[]>;
}

const schemas = {
  resolve: z.object({ tenant_id: uuid, location_id: uuid }),
  waContext: waContextSchema,
  services: z.object({ services: z.array(serviceSchema) }),
  ticket: ticketSchema,
  activeTicket: z.object({ ticket: ticketSchema.nullable() }),
  slots: z.object({
    date: z.string(),
    slot_interval_min: z.number(),
    slots: z.array(z.object({ start_time: iso, end_time: iso })),
  }),
  booking: bookingSchema,
  bookings: z.object({ bookings: z.array(bookingSchema) }),
  items: z.object({
    items: z.array(
      z.object({
        kind: z.enum(['TICKET', 'BOOKING']),
        tenant_id: uuid,
        location_id: uuid,
        item_id: uuid,
      }),
    ),
  }),
};

const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export interface CoreClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

type Method = 'GET' | 'POST';

export class CoreClient implements CoreApi {
  private readonly options: CoreClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CoreClientOptions) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, '') };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async resolveLocation(slug: string, code: string): Promise<ResolveLocationResponse | null> {
    try {
      return await this.call(
        'GET',
        `/locations/resolve?${new URLSearchParams({ slug, code })}`,
        null,
        schemas.resolve,
      );
    } catch (error) {
      // 404 = no such active location; 400 = the keyword parts are malformed.
      if (error instanceof CoreApiError && (error.status === 404 || error.status === 400)) {
        return null;
      }
      throw error;
    }
  }

  async waContext(tenantId: string, locationId: string): Promise<CoreWaContext> {
    return this.call(
      'GET',
      `/locations/${encodeURIComponent(locationId)}/wa-context`,
      tenantId,
      schemas.waContext,
    );
  }

  async listServices(tenantId: string, locationId: string): Promise<CoreService[]> {
    const body = await this.call(
      'GET',
      `/catalog/services?${new URLSearchParams({ location_id: locationId })}`,
      tenantId,
      schemas.services,
    );
    return body.services;
  }

  async createTicket(tenantId: string, input: CreateTicketInput): Promise<CoreTicket> {
    return this.call('POST', '/queues/tickets', tenantId, schemas.ticket, input);
  }

  async activeTicket(
    tenantId: string,
    locationId: string,
    phone: string,
  ): Promise<CoreTicket | null> {
    const body = await this.call(
      'GET',
      `/queues/tickets/active?${new URLSearchParams({ location_id: locationId, customer_phone: phone })}`,
      tenantId,
      schemas.activeTicket,
    );
    return body.ticket;
  }

  async cancelTicket(tenantId: string, ticketId: string, phone: string): Promise<CoreTicket> {
    return this.call(
      'POST',
      `/queues/tickets/${encodeURIComponent(ticketId)}/cancel`,
      tenantId,
      schemas.ticket,
      { customer_phone: phone },
    );
  }

  async availableSlots(
    tenantId: string,
    locationId: string,
    serviceId: string,
    date: string,
  ): Promise<CoreSlots> {
    return this.call(
      'GET',
      `/bookings/available-slots?${new URLSearchParams({ location_id: locationId, service_id: serviceId, date })}`,
      tenantId,
      schemas.slots,
    );
  }

  async createHold(tenantId: string, input: CreateHoldInput): Promise<CoreBooking> {
    return this.call('POST', '/bookings/holds', tenantId, schemas.booking, input);
  }

  async activeBookings(
    tenantId: string,
    locationId: string,
    phone: string,
  ): Promise<CoreBooking[]> {
    const body = await this.call(
      'GET',
      `/bookings/active?${new URLSearchParams({ location_id: locationId, customer_phone: phone })}`,
      tenantId,
      schemas.bookings,
    );
    return body.bookings;
  }

  async cancelBooking(tenantId: string, bookingId: string, phone: string): Promise<CoreBooking> {
    return this.call(
      'POST',
      `/bookings/${encodeURIComponent(bookingId)}/cancel`,
      tenantId,
      schemas.booking,
      { customer_phone: phone },
    );
  }

  async activeItems(phone: string): Promise<ActiveItemDto[]> {
    const body = await this.call(
      'GET',
      `/customers/active-items?${new URLSearchParams({ customer_phone: phone })}`,
      null,
      schemas.items,
    );
    return body.items;
  }

  private async call<S extends z.ZodType>(
    method: Method,
    path: string,
    tenantId: string | null,
    schema: S,
    body?: object,
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.serviceToken}`,
      accept: 'application/json',
    };
    if (tenantId !== null) headers['x-antre-tenant-id'] = tenantId;
    if (body !== undefined) headers['content-type'] = 'application/json';
    // The path (it may hold a phone number) is never put into an error message.
    const endpoint = `${method} ${path.split('?')[0]}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/internal/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'timed out'
          : 'unreachable';
      throw new CoreUnavailableError(`core services ${reason}: ${endpoint}`, { cause: error });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (response.status >= 500 || response.status === 401 || response.status === 403) {
      // 401/403 = wrong service token: a configuration problem, not a customer error.
      throw new CoreUnavailableError(`core services answered ${response.status}: ${endpoint}`);
    }
    if (response.status >= 400) {
      const error = errorBodySchema.safeParse(json);
      if (!error.success) {
        throw new CoreUnavailableError(`core services answered ${response.status}: ${endpoint}`);
      }
      throw new CoreApiError(
        response.status,
        error.data.error.code,
        error.data.error.message,
        error.data.error.details,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new CoreUnavailableError(`unexpected response body: ${endpoint}`);
    }
    return parsed.data;
  }
}
