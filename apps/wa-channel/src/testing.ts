// Test doubles for the unit tests: an in-memory core services fake with one tenant and location,
// and a recording event sink. Not imported by server.ts (never part of the bundle).
import type { EventEnvelope } from '@antre/event-contracts';
import type { ActiveItemDto } from '@antre/shared-types';

import {
  CoreApiError,
  type CoreApi,
  type CoreBooking,
  type CoreService,
  type CoreSlots,
  type CoreTicket,
  type CoreWaContext,
  type CreateHoldInput,
  type CreateTicketInput,
} from './core-client.js';
import type { EventSink } from './webhook/routes.js';

export const TENANT_ID = 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1';
export const LOCATION_ID = '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90';
export const OTHER_TENANT_ID = '7d4c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a09';
export const OTHER_LOCATION_ID = '8e5d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b';
export const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
export const DP_SERVICE_ID = '22222222-2222-4222-8222-222222222222';
export const PHONE = '6281234567890';

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

export class RecordingSink implements EventSink {
  connected = true;
  readonly events: EventEnvelope[] = [];

  async publish(event: EventEnvelope): Promise<void> {
    this.events.push(event);
  }

  ofType<K extends EventEnvelope['event_type']>(type: K): EventEnvelope<K>[] {
    return this.events.filter((event) => event.event_type === type) as EventEnvelope<K>[];
  }
}

type CallName = keyof CoreApi;

/** Fake core services: one tenant "Klinik Sehat" (slug klinik-sehat, location pusat). */
export class FakeCore implements CoreApi {
  readonly calls: { name: CallName; args: unknown[] }[] = [];
  /** Next call of `name` throws this error (once). */
  readonly failures = new Map<CallName, Error[]>();
  context: CoreWaContext = {
    tenant: { id: TENANT_ID, name: 'Klinik Sehat' },
    location: {
      id: LOCATION_ID,
      code: 'pusat',
      name: 'Cabang Pusat',
      timezone: 'Asia/Jakarta',
      is_active: true,
    },
    service_mode: 'BOTH',
    show_wait_estimate: true,
    branding: { wa_greeting: null, resource_label: null },
  };
  otherContext: CoreWaContext = {
    tenant: { id: OTHER_TENANT_ID, name: 'GOR Juara' },
    location: {
      id: OTHER_LOCATION_ID,
      code: 'utama',
      name: 'Utama',
      timezone: 'Asia/Jakarta',
      is_active: true,
    },
    service_mode: 'RESERVATION',
    show_wait_estimate: false,
    branding: { wa_greeting: null, resource_label: 'Lapangan' },
  };
  services: CoreService[] = [
    {
      id: SERVICE_ID,
      name: 'Poli Umum',
      ticket_prefix: 'A',
      avg_duration_min: 10,
      price: 0,
      requires_dp: false,
      dp_amount: null,
      is_active: true,
    },
    {
      id: DP_SERVICE_ID,
      name: 'Konsultasi Spesialis',
      ticket_prefix: 'B',
      avg_duration_min: 30,
      price: 150000,
      requires_dp: true,
      dp_amount: 50000,
      is_active: true,
    },
  ];
  /** Free slots per local date; dates not listed have none. */
  slots = new Map<string, { start_time: string; end_time: string }[]>();
  tickets: CoreTicket[] = [];
  bookings: (CoreBooking & { tenant_id: string })[] = [];

  private record(name: CallName, args: unknown[]): void {
    this.calls.push({ name, args });
    const queued = this.failures.get(name);
    const failure = queued?.shift();
    if (failure !== undefined) throw failure;
  }

  failNext(name: CallName, error: Error): void {
    this.failures.set(name, [...(this.failures.get(name) ?? []), error]);
  }

  callsOf(name: CallName): unknown[][] {
    return this.calls.filter((call) => call.name === name).map((call) => call.args);
  }

  private contextOf(tenantId: string): CoreWaContext {
    return tenantId === OTHER_TENANT_ID ? this.otherContext : this.context;
  }

  async resolveLocation(slug: string, code: string) {
    this.record('resolveLocation', [slug, code]);
    if (slug === 'klinik-sehat' && code === 'pusat') {
      return { tenant_id: TENANT_ID, location_id: LOCATION_ID };
    }
    if (slug === 'gor-juara' && code === 'utama') {
      return { tenant_id: OTHER_TENANT_ID, location_id: OTHER_LOCATION_ID };
    }
    return null;
  }

  async waContext(tenantId: string, locationId: string) {
    this.record('waContext', [tenantId, locationId]);
    return structuredClone(this.contextOf(tenantId));
  }

  async listServices(tenantId: string, locationId: string) {
    this.record('listServices', [tenantId, locationId]);
    return structuredClone(this.services);
  }

  async createTicket(tenantId: string, input: CreateTicketInput) {
    this.record('createTicket', [tenantId, input]);
    const existing = this.tickets.find(
      (ticket) =>
        ticket.customer_phone === input.customer_phone &&
        ['WAITING', 'CALLED', 'SERVING'].includes(ticket.status),
    );
    if (existing) {
      throw new CoreApiError(409, 'ACTIVE_TICKET_EXISTS', 'aktif', { ticket: existing });
    }
    const service = this.services.find((candidate) => candidate.id === input.service_id)!;
    const ticket: CoreTicket = {
      id: nextId(),
      location_id: input.location_id,
      service_id: input.service_id,
      service_name: service.name,
      resource_name: null,
      ticket_number: `${service.ticket_prefix}-${String(this.tickets.length + 1).padStart(3, '0')}`,
      customer_name: input.customer_name,
      customer_phone: input.customer_phone,
      status: 'WAITING',
      people_ahead: 2,
      estimated_serve_time: '2026-10-19T03:20:00.000Z',
    };
    this.tickets.push(ticket);
    return structuredClone(ticket);
  }

  async activeTicket(tenantId: string, locationId: string, phone: string) {
    this.record('activeTicket', [tenantId, locationId, phone]);
    const ticket = this.tickets.find(
      (candidate) =>
        candidate.location_id === locationId &&
        candidate.customer_phone === phone &&
        ['WAITING', 'CALLED', 'SERVING'].includes(candidate.status),
    );
    return ticket === undefined ? null : structuredClone(ticket);
  }

  async cancelTicket(tenantId: string, ticketId: string, phone: string) {
    this.record('cancelTicket', [tenantId, ticketId, phone]);
    const ticket = this.tickets.find((candidate) => candidate.id === ticketId);
    if (!ticket || ticket.customer_phone !== phone) {
      throw new CoreApiError(404, 'NOT_FOUND', 'Tiket tidak ditemukan.');
    }
    if (ticket.status !== 'WAITING') {
      throw new CoreApiError(409, 'INVALID_TRANSITION', 'Hanya tiket WAITING.');
    }
    ticket.status = 'CANCELLED';
    return structuredClone(ticket);
  }

  async availableSlots(
    tenantId: string,
    locationId: string,
    serviceId: string,
    date: string,
  ): Promise<CoreSlots> {
    this.record('availableSlots', [tenantId, locationId, serviceId, date]);
    return { date, slot_interval_min: 30, slots: structuredClone(this.slots.get(date) ?? []) };
  }

  async createHold(tenantId: string, input: CreateHoldInput) {
    this.record('createHold', [tenantId, input]);
    const service = this.services.find((candidate) => candidate.id === input.service_id)!;
    const booking: CoreBooking & { tenant_id: string } = {
      tenant_id: tenantId,
      id: nextId(),
      location_id: input.location_id,
      service_id: input.service_id,
      service_name: service.name,
      resource_name: 'Ruang A',
      customer_name: input.customer_name,
      customer_phone: input.customer_phone,
      start_time: input.slot_start,
      end_time: new Date(Date.parse(input.slot_start) + 30 * 60_000).toISOString(),
      status: service.requires_dp ? 'PENDING_PAYMENT' : 'CONFIRMED',
      payment_status: service.requires_dp ? 'UNPAID' : 'NOT_REQUIRED',
      dp_amount: service.dp_amount,
      payment_ref: service.requires_dp ? 'pay-abc' : null,
      hold_expires_at: service.requires_dp ? '2026-10-19T03:05:00.000Z' : null,
    };
    this.bookings.push(booking);
    return structuredClone(booking);
  }

  async activeBookings(tenantId: string, locationId: string, phone: string) {
    this.record('activeBookings', [tenantId, locationId, phone]);
    return structuredClone(
      this.bookings.filter(
        (booking) =>
          booking.location_id === locationId &&
          booking.customer_phone === phone &&
          ['PENDING_PAYMENT', 'CONFIRMED'].includes(booking.status),
      ),
    );
  }

  async cancelBooking(tenantId: string, bookingId: string, phone: string) {
    this.record('cancelBooking', [tenantId, bookingId, phone]);
    const booking = this.bookings.find((candidate) => candidate.id === bookingId);
    if (!booking || booking.customer_phone !== phone) {
      throw new CoreApiError(404, 'NOT_FOUND', 'Reservasi tidak ditemukan.');
    }
    booking.status = 'CANCELLED';
    return structuredClone(booking);
  }

  async activeItems(phone: string): Promise<ActiveItemDto[]> {
    this.record('activeItems', [phone]);
    const tickets: ActiveItemDto[] = this.tickets
      .filter(
        (ticket) =>
          ticket.customer_phone === phone &&
          ['WAITING', 'CALLED', 'SERVING'].includes(ticket.status),
      )
      .map((ticket) => ({
        kind: 'TICKET',
        tenant_id: ticket.location_id === OTHER_LOCATION_ID ? OTHER_TENANT_ID : TENANT_ID,
        location_id: ticket.location_id,
        item_id: ticket.id,
      }));
    const bookings: ActiveItemDto[] = this.bookings
      .filter(
        (booking) =>
          booking.customer_phone === phone &&
          ['PENDING_PAYMENT', 'CONFIRMED'].includes(booking.status),
      )
      .sort((a, b) => a.start_time.localeCompare(b.start_time))
      .map((booking) => ({
        kind: 'BOOKING',
        tenant_id: booking.tenant_id,
        location_id: booking.location_id,
        item_id: booking.id,
      }));
    return [...tickets, ...bookings];
  }
}
