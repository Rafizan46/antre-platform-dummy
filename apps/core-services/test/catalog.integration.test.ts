import type { LocationDto, OperatingHoursDto, ResourceDto, ServiceDto } from '@antre/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiRequest,
  bearer,
  createTestApp,
  login,
  queryInTenant,
  registerTenant,
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

const SERVICE = { name: 'Umum', ticket_prefix: 'A', avg_duration_min: 10 };

function api(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  headers: Record<string, string>,
  payload?: object,
) {
  return apiRequest(ctx.app, method, url, headers, payload);
}

async function ownerOf(tenant?: Awaited<ReturnType<typeof registerTenant>>) {
  const registered = tenant ?? (await registerTenant(ctx.app));
  const headers = bearer(await login(ctx.app, registered.ownerEmail, registered.password));
  return { tenant: registered, headers };
}

describe('locations', () => {
  it('creates a location with a FREE subscription and lists, updates, and guards it', async () => {
    const { tenant, headers } = await ownerOf();

    const created = await api('POST', '/api/v1/locations', headers, {
      code: 'cabang-2',
      name: 'Cabang Dua',
      timezone: 'Asia/Makassar',
    });
    expect(created.statusCode).toBe(201);
    const location = created.json<LocationDto>();
    expect(location).toMatchObject({
      code: 'cabang-2',
      timezone: 'Asia/Makassar',
      slot_interval_min: 60,
      is_active: true,
      address: null,
    });

    const subscriptions = await queryInTenant<{ plan_code: string }>(
      ctx.pool,
      tenant.tenantId,
      'SELECT plan_code FROM subscriptions WHERE location_id = $1',
      [location.id],
    );
    expect(subscriptions).toEqual([{ plan_code: 'FREE' }]);

    const duplicate = await api('POST', '/api/v1/locations', headers, {
      code: 'cabang-2',
      name: 'Lagi',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('ALREADY_EXISTS');

    const patched = await api('PATCH', `/api/v1/locations/${location.id}`, headers, {
      name: 'Cabang Baru',
      address: 'Jl. Contoh 1',
      is_active: false,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: 'Cabang Baru',
      address: 'Jl. Contoh 1',
      is_active: false,
      code: 'cabang-2',
    });
    const cleared = await api('PATCH', `/api/v1/locations/${location.id}`, headers, {
      address: null,
    });
    expect(cleared.json().address).toBeNull();

    expect((await api('PATCH', `/api/v1/locations/${location.id}`, headers, {})).statusCode).toBe(
      400,
    );
    expect(
      (await api('PATCH', `/api/v1/locations/${location.id}`, headers, { code: 'x' })).statusCode,
    ).toBe(400);

    const list = await api('GET', '/api/v1/locations', headers);
    expect(list.json<{ locations: LocationDto[] }>().locations.map((l) => l.code)).toEqual([
      'cabang-2',
      'pusat',
    ]);
  });

  it('lets staff read but not write, and hides locations of other tenants', async () => {
    const fixture = await setupQueueFixture(ctx);
    expect((await api('GET', '/api/v1/locations', fixture.caller)).statusCode).toBe(200);
    expect(
      (await api('POST', '/api/v1/locations', fixture.caller, { code: 'x', name: 'X' })).statusCode,
    ).toBe(403);
    expect(
      (await api('PATCH', `/api/v1/locations/${fixture.locationId}`, fixture.caller, { name: 'X' }))
        .statusCode,
    ).toBe(403);

    const other = await ownerOf();
    const patch = await api('PATCH', `/api/v1/locations/${fixture.locationId}`, other.headers, {
      name: 'Dibajak',
    });
    expect(patch.statusCode).toBe(404);
    expect(
      (await api('PATCH', '/api/v1/locations/not-a-uuid', other.headers, { name: 'X' })).statusCode,
    ).toBe(404);
  });
});

describe('services', () => {
  it('creates, lists, and updates services and guards the ticket prefix per tenant', async () => {
    const { headers } = await ownerOf();

    const created = await api('POST', '/api/v1/catalog/services', headers, {
      ...SERVICE,
      price: 50000,
      requires_dp: true,
      dp_amount: 20000,
    });
    expect(created.statusCode).toBe(201);
    const service = created.json<ServiceDto>();
    expect(service).toMatchObject({
      ticket_prefix: 'A',
      price: 50000,
      requires_dp: true,
      dp_amount: 20000,
      is_active: true,
    });

    const duplicate = await api('POST', '/api/v1/catalog/services', headers, {
      ...SERVICE,
      name: 'Lain',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('ALREADY_EXISTS');

    const second = await api('POST', '/api/v1/catalog/services', headers, {
      name: 'Kasir',
      ticket_prefix: 'B',
      avg_duration_min: 5,
    });
    const clash = await api(
      'PATCH',
      `/api/v1/catalog/services/${second.json<ServiceDto>().id}`,
      headers,
      { ticket_prefix: 'A' },
    );
    expect(clash.statusCode).toBe(409);

    const patched = await api('PATCH', `/api/v1/catalog/services/${service.id}`, headers, {
      requires_dp: false,
      dp_amount: null,
      avg_duration_min: 15,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      requires_dp: false,
      dp_amount: null,
      avg_duration_min: 15,
    });

    const invalid = await api('PATCH', `/api/v1/catalog/services/${service.id}`, headers, {
      requires_dp: true,
    });
    expect(invalid.statusCode).toBe(400);

    const list = await api('GET', '/api/v1/catalog/services', headers);
    expect(list.json<{ services: ServiceDto[] }>().services.map((s) => s.ticket_prefix)).toEqual([
      'B',
      'A',
    ]);
  });

  it('lets another tenant reuse a prefix but not see or change the service', async () => {
    const first = await ownerOf();
    const created = await api('POST', '/api/v1/catalog/services', first.headers, SERVICE);
    const serviceId = created.json<ServiceDto>().id;

    const second = await ownerOf();
    expect(
      (await api('POST', '/api/v1/catalog/services', second.headers, SERVICE)).statusCode,
    ).toBe(201);
    const patch = await api('PATCH', `/api/v1/catalog/services/${serviceId}`, second.headers, {
      name: 'Dibajak',
    });
    expect(patch.statusCode).toBe(404);
    const list = await api('GET', '/api/v1/catalog/services', second.headers);
    expect(list.json<{ services: ServiceDto[] }>().services).toHaveLength(1);
  });

  it('lets staff read but not write', async () => {
    const fixture = await setupQueueFixture(ctx);
    expect((await api('GET', '/api/v1/catalog/services', fixture.cashier)).statusCode).toBe(200);
    expect(
      (
        await api('POST', '/api/v1/catalog/services', fixture.cashier, {
          ...SERVICE,
          ticket_prefix: 'Z',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api('PATCH', `/api/v1/catalog/services/${fixture.serviceId}`, fixture.caller, {
          name: 'X',
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('resources', () => {
  it('creates a resource with services, lists it, and replaces its services', async () => {
    const fixture = await setupQueueFixture(ctx);
    const extra = await api('POST', '/api/v1/catalog/services', fixture.owner, {
      name: 'Kasir',
      ticket_prefix: 'B',
      avg_duration_min: 5,
    });
    const extraId = extra.json<ServiceDto>().id;

    const created = await api('POST', '/api/v1/catalog/resources', fixture.owner, {
      location_id: fixture.locationId,
      name: 'Dokter Ani',
      resource_type: 'DOCTOR',
      service_ids: [fixture.serviceId, extraId],
    });
    expect(created.statusCode).toBe(201);
    const resource = created.json<ResourceDto>();
    expect(resource.service_ids.sort()).toEqual([fixture.serviceId, extraId].sort());
    expect(resource).toMatchObject({ resource_type: 'DOCTOR', is_active: true });

    const patched = await api('PATCH', `/api/v1/catalog/resources/${resource.id}`, fixture.owner, {
      service_ids: [extraId],
      is_active: false,
      resource_type: null,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      service_ids: [extraId],
      is_active: false,
      resource_type: null,
    });

    const cleared = await api('PATCH', `/api/v1/catalog/resources/${resource.id}`, fixture.owner, {
      service_ids: [],
    });
    expect(cleared.json<ResourceDto>().service_ids).toEqual([]);

    const list = await api(
      'GET',
      `/api/v1/catalog/resources?location_id=${fixture.locationId}`,
      fixture.cashier,
    );
    const resources = list.json<{ resources: ResourceDto[] }>().resources;
    expect(resources.map((r) => r.name)).toEqual(['Dokter Ani', 'Loket 1']);
    expect(resources.find((r) => r.name === 'Loket 1')?.service_ids).toEqual([fixture.serviceId]);

    expect(
      (
        await api('POST', '/api/v1/catalog/resources', fixture.caller, {
          location_id: fixture.locationId,
          name: 'X',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('answers 404 for a location, service, or resource of another tenant', async () => {
    const mine = await setupQueueFixture(ctx);
    const other = await setupQueueFixture(ctx);

    const foreignLocation = await api('POST', '/api/v1/catalog/resources', mine.owner, {
      location_id: other.locationId,
      name: 'X',
    });
    expect(foreignLocation.statusCode).toBe(404);

    const foreignService = await api('POST', '/api/v1/catalog/resources', mine.owner, {
      location_id: mine.locationId,
      name: 'X',
      service_ids: [other.serviceId],
    });
    expect(foreignService.statusCode).toBe(404);

    const foreignPatch = await api(
      'PATCH',
      `/api/v1/catalog/resources/${other.resourceId}`,
      mine.owner,
      {
        name: 'Dibajak',
      },
    );
    expect(foreignPatch.statusCode).toBe(404);

    const foreignServiceOnPatch = await api(
      'PATCH',
      `/api/v1/catalog/resources/${mine.resourceId}`,
      mine.owner,
      { service_ids: [other.serviceId] },
    );
    expect(foreignServiceOnPatch.statusCode).toBe(404);
    const unchanged = await api(
      'GET',
      `/api/v1/catalog/resources?location_id=${mine.locationId}`,
      mine.owner,
    );
    expect(unchanged.json<{ resources: ResourceDto[] }>().resources[0]?.service_ids).toEqual([
      mine.serviceId,
    ]);
  });
});

describe('operating hours', () => {
  it('round-trips hours with a break and replaces the whole week', async () => {
    const { headers } = await ownerOf();
    const locations = await api('GET', '/api/v1/locations', headers);
    const locationId = locations.json<{ locations: LocationDto[] }>().locations[0]!.id;
    const url = `/api/v1/catalog/locations/${locationId}/operating-hours`;

    const empty = await api('GET', url, headers);
    expect(empty.json<OperatingHoursDto>()).toEqual({
      location_id: locationId,
      slot_interval_min: 60,
      days: [],
    });

    const put = await api('PUT', url, headers, {
      slot_interval_min: 30,
      days: [
        {
          day_of_week: 3,
          open_time: '08:00',
          close_time: '17:00',
          break_start: '12:00',
          break_end: '13:00',
        },
        { day_of_week: 1, open_time: '09:30', close_time: '16:00' },
      ],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<OperatingHoursDto>()).toEqual({
      location_id: locationId,
      slot_interval_min: 30,
      days: [
        {
          day_of_week: 1,
          open_time: '09:30',
          close_time: '16:00',
          break_start: null,
          break_end: null,
        },
        {
          day_of_week: 3,
          open_time: '08:00',
          close_time: '17:00',
          break_start: '12:00',
          break_end: '13:00',
        },
      ],
    });

    const replaced = await api('PUT', url, headers, {
      slot_interval_min: 30,
      days: [{ day_of_week: 0, open_time: '10:00', close_time: '12:00' }],
    });
    expect(replaced.json<OperatingHoursDto>().days).toHaveLength(1);
    const read = await api('GET', url, headers);
    expect(read.json<OperatingHoursDto>().days.map((d) => d.day_of_week)).toEqual([0]);
  });

  it('rejects invalid hours, guards writes, and hides other tenants', async () => {
    const fixture = await setupQueueFixture(ctx);
    const url = `/api/v1/catalog/locations/${fixture.locationId}/operating-hours`;
    const day = { day_of_week: 1, open_time: '08:00', close_time: '17:00' };

    const brokenBreak = await api('PUT', url, fixture.owner, {
      slot_interval_min: 30,
      days: [{ ...day, break_start: '16:00', break_end: '18:00' }],
    });
    expect(brokenBreak.statusCode).toBe(400);
    const duplicate = await api('PUT', url, fixture.owner, {
      slot_interval_min: 30,
      days: [day, day],
    });
    expect(duplicate.statusCode).toBe(400);

    expect((await api('GET', url, fixture.cashier)).statusCode).toBe(200);
    expect(
      (await api('PUT', url, fixture.cashier, { slot_interval_min: 30, days: [] })).statusCode,
    ).toBe(403);

    const other = await ownerOf();
    expect((await api('GET', url, other.headers)).statusCode).toBe(404);
    expect(
      (await api('PUT', url, other.headers, { slot_interval_min: 30, days: [] })).statusCode,
    ).toBe(404);
  });
});
