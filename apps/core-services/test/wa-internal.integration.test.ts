// /internal/v1 endpoints of Tenant & Auth for the WhatsApp Channel Service (S09): location
// resolution, the WhatsApp context of a location, and the active items of a phone number.
import type {
  ActiveItemsResponse,
  BookingDto,
  QueueTicketDto,
  ResolveLocationResponse,
  WaContextDto,
} from '@antre/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiRequest,
  createTestApp,
  internalHeaders,
  setupBookingFixture,
  setupQueueFixture,
  type TestApp,
} from './helpers.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

function service(): Record<string, string> {
  return { authorization: `Bearer ${ctx.waChannelToken}` };
}

describe('GET /internal/v1/locations/resolve', () => {
  it('resolves the QR keyword case-insensitively without a tenant header (FR-WA-03)', async () => {
    const f = await setupQueueFixture(ctx);
    const response = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/locations/resolve?slug=${f.tenant.slug.toUpperCase()}&code=PUSAT`,
      service(),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<ResolveLocationResponse>()).toEqual({
      tenant_id: f.tenant.tenantId,
      location_id: f.locationId,
    });
  });

  it('answers 404 for an unknown or inactive location and 400 for a malformed keyword', async () => {
    const f = await setupQueueFixture(ctx);
    const unknown = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/locations/resolve?slug=${f.tenant.slug}&code=cabang-x`,
      service(),
    );
    expect(unknown.statusCode).toBe(404);

    const deactivate = await apiRequest(
      ctx.app,
      'PATCH',
      `/api/v1/locations/${f.locationId}`,
      f.owner,
      { is_active: false },
    );
    expect(deactivate.statusCode).toBe(200);
    const inactive = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/locations/resolve?slug=${f.tenant.slug}&code=pusat`,
      service(),
    );
    expect(inactive.statusCode).toBe(404);

    const malformed = await apiRequest(
      ctx.app,
      'GET',
      '/internal/v1/locations/resolve?slug=bad%20slug&code=pusat',
      service(),
    );
    expect(malformed.statusCode).toBe(400);
  });

  it('requires the service token', async () => {
    const response = await apiRequest(
      ctx.app,
      'GET',
      '/internal/v1/locations/resolve?slug=x&code=y',
      { authorization: 'Bearer wrong-token' },
    );
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /internal/v1/locations/:id/wa-context', () => {
  it('returns names, service mode, estimate toggle, time zone, and branding (FR-WA-04)', async () => {
    const f = await setupQueueFixture(ctx);
    const settings = await apiRequest(ctx.app, 'PATCH', '/api/v1/tenants/me/settings', f.owner, {
      service_mode: 'WALK_IN',
      show_wait_estimate: false,
      branding: { wa_greeting: 'Selamat datang di Klinik!', labels: { resource: 'Dokter' } },
    });
    expect(settings.statusCode).toBe(200);

    const response = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/locations/${f.locationId}/wa-context`,
      internalHeaders(ctx, f.tenant.tenantId),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<WaContextDto>();
    expect(body).toEqual({
      tenant: { id: f.tenant.tenantId, name: expect.any(String) },
      location: {
        id: f.locationId,
        code: 'pusat',
        name: 'Pusat',
        timezone: 'Asia/Jakarta',
        is_active: true,
      },
      service_mode: 'WALK_IN',
      show_wait_estimate: false,
      branding: { wa_greeting: 'Selamat datang di Klinik!', resource_label: 'Dokter' },
    });
  });

  it('defaults branding to null and hides locations of other tenants (RLS)', async () => {
    const a = await setupQueueFixture(ctx);
    const b = await setupQueueFixture(ctx);
    const own = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/locations/${a.locationId}/wa-context`,
      internalHeaders(ctx, a.tenant.tenantId),
    );
    expect(own.json<WaContextDto>().branding).toEqual({ wa_greeting: null, resource_label: null });

    const foreign = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/locations/${a.locationId}/wa-context`,
      internalHeaders(ctx, b.tenant.tenantId),
    );
    expect(foreign.statusCode).toBe(404);

    const missingHeader = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/locations/${a.locationId}/wa-context`,
      service(),
    );
    expect(missingHeader.statusCode).toBe(400);
  });
});

describe('GET /internal/v1/customers/active-items', () => {
  it('lists the active ticket and upcoming bookings of a phone across tenants (FR-WA-06)', async () => {
    const phone = '6285550001111';
    const queue = await setupQueueFixture(ctx);
    const booking = await setupBookingFixture(ctx);

    const ticket = await apiRequest(
      ctx.app,
      'POST',
      '/internal/v1/queues/tickets',
      internalHeaders(ctx, queue.tenant.tenantId),
      { location_id: queue.locationId, service_id: queue.serviceId, customer_phone: phone },
    );
    expect(ticket.statusCode).toBe(201);

    const slots = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/bookings/available-slots?location_id=${booking.locationId}&service_id=${booking.freeServiceId}&date=${tomorrow()}`,
      internalHeaders(ctx, booking.tenant.tenantId),
    );
    expect(slots.statusCode).toBe(200);
    const slotStart = slots.json<{ slots: { start_time: string }[] }>().slots[0]!.start_time;
    const hold = await apiRequest(
      ctx.app,
      'POST',
      '/internal/v1/bookings/holds',
      internalHeaders(ctx, booking.tenant.tenantId),
      {
        location_id: booking.locationId,
        service_id: booking.freeServiceId,
        slot_start: slotStart,
        customer_name: 'Budi',
        customer_phone: phone,
      },
    );
    expect(hold.statusCode).toBe(201);

    // X-Antre-Tenant-Id is ignored here, even when it is not a uuid.
    const response = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/customers/active-items?customer_phone=${phone}`,
      { ...service(), 'x-antre-tenant-id': 'not-a-uuid' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<ActiveItemsResponse>().items).toEqual([
      {
        kind: 'TICKET',
        tenant_id: queue.tenant.tenantId,
        location_id: queue.locationId,
        item_id: ticket.json<QueueTicketDto>().id,
      },
      {
        kind: 'BOOKING',
        tenant_id: booking.tenant.tenantId,
        location_id: booking.locationId,
        item_id: hold.json<BookingDto>().id,
      },
    ]);

    const other = await apiRequest(
      ctx.app,
      'GET',
      '/internal/v1/customers/active-items?customer_phone=6285550002222',
      service(),
    );
    expect(other.json<ActiveItemsResponse>().items).toEqual([]);

    const invalid = await apiRequest(
      ctx.app,
      'GET',
      '/internal/v1/customers/active-items?customer_phone=%2B62855',
      service(),
    );
    expect(invalid.statusCode).toBe(400);
  });
});

/** Tomorrow in Asia/Jakarta as YYYY-MM-DD. */
function tomorrow(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date);
}
