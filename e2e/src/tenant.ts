// Provisions a complete tenant through the public API, exactly as an owner would on day one:
// register, log in, services (without and with down payment), two resources, opening hours all
// day, service mode BOTH, a caller and a cashier, and a kiosk token.
import { randomBytes } from 'node:crypto';

import { api } from './api.js';
import { newPhone } from './wa.js';

export interface TenantFixture {
  slug: string;
  locationCode: string;
  tenantId: string;
  /** WhatsApp number of the tenant admin (receives quota and subscription notices). */
  adminPhone: string;
  locationId: string;
  owner: { email: string; password: string; token: string };
  caller: { email: string; password: string; token: string };
  cashier: { email: string; password: string; token: string };
  kioskToken: string;
  /** Service without down payment (prefix A). */
  freeServiceId: string;
  /** Service with a down payment (prefix B). */
  dpServiceId: string;
  dpAmount: number;
  resourceIds: string[];
}

export function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

function expectStatus(label: string, response: { status: number; body: unknown }, status: number) {
  if (response.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
}

export const ALL_DAY_HOURS = {
  slot_interval_min: 30,
  days: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day_of_week: day,
    open_time: '00:00',
    close_time: '23:30',
    break_start: null,
    break_end: null,
  })),
};

export async function provisionTenant(
  options: { prefix?: string; resources?: number } = {},
): Promise<TenantFixture> {
  const prefix = options.prefix ?? 'e2e';
  const suffix = randomSuffix();
  const slug = `${prefix}-${suffix}`;
  const locationCode = 'pusat';
  const password = `Sup3rSecret-${suffix}`;
  // Unique per tenant, so the admin notifications of one journey never mix with another.
  const adminPhone = newPhone();
  const ownerEmail = `owner@${slug}.test`;

  const registered = await api('POST', '/api/v1/auth/register', {
    body: {
      tenant: {
        name: `Klinik ${slug}`,
        slug,
        business_type: 'CLINIC',
        admin_wa_phone: adminPhone,
      },
      location: { name: 'Pusat', code: locationCode },
      owner: { email: ownerEmail, password },
    },
  });
  expectStatus('register', registered, 201);
  const tenantId: string = registered.body.tenant.id;
  const locationId: string = registered.body.location.id;

  const login = async (email: string, pass: string): Promise<string> => {
    const response = await api('POST', '/api/v1/auth/login', { body: { email, password: pass } });
    expectStatus(`login ${email}`, response, 200);
    return response.body.access_token as string;
  };
  const ownerToken = await login(ownerEmail, password);

  const free = await api('POST', '/api/v1/catalog/services', {
    token: ownerToken,
    body: { name: 'Konsultasi', ticket_prefix: 'A', avg_duration_min: 15 },
  });
  expectStatus('service without DP', free, 201);
  const dpAmount = 50_000;
  const dp = await api('POST', '/api/v1/catalog/services', {
    token: ownerToken,
    body: {
      name: 'Perawatan',
      ticket_prefix: 'B',
      avg_duration_min: 30,
      price: 100_000,
      requires_dp: true,
      dp_amount: dpAmount,
    },
  });
  expectStatus('service with DP', dp, 201);
  const serviceIds = [free.body.id as string, dp.body.id as string];

  const resourceIds: string[] = [];
  for (const name of ['Dokter 1', 'Dokter 2'].slice(0, options.resources ?? 2)) {
    const resource = await api('POST', '/api/v1/catalog/resources', {
      token: ownerToken,
      body: { location_id: locationId, name, service_ids: serviceIds },
    });
    expectStatus(`resource ${name}`, resource, 201);
    resourceIds.push(resource.body.id as string);
  }

  expectStatus(
    'operating hours',
    await api('PUT', `/api/v1/catalog/locations/${locationId}/operating-hours`, {
      token: ownerToken,
      body: ALL_DAY_HOURS,
    }),
    200,
  );
  expectStatus(
    'service mode',
    await api('PATCH', '/api/v1/tenants/me/settings', {
      token: ownerToken,
      body: { service_mode: 'BOTH', show_wait_estimate: true },
    }),
    200,
  );

  const staff = async (role: 'STAFF_CALLER' | 'STAFF_CASHIER', name: string) => {
    const email = `${name}@${slug}.test`;
    const pass = `${name}-Pass-123`;
    expectStatus(
      `create ${role}`,
      await api('POST', '/api/v1/users', {
        token: ownerToken,
        body: { email, password: pass, role },
      }),
      201,
    );
    return { email, password: pass, token: await login(email, pass) };
  };
  const caller = await staff('STAFF_CALLER', 'caller');
  const cashier = await staff('STAFF_CASHIER', 'cashier');

  const kiosk = await api('POST', `/api/v1/locations/${locationId}/kiosk-tokens`, {
    token: ownerToken,
  });
  expectStatus('kiosk token', kiosk, 201);

  return {
    slug,
    locationCode,
    tenantId,
    adminPhone,
    locationId,
    owner: { email: ownerEmail, password, token: ownerToken },
    caller,
    cashier,
    kioskToken: kiosk.body.token as string,
    freeServiceId: serviceIds[0]!,
    dpServiceId: serviceIds[1]!,
    dpAmount,
    resourceIds,
  };
}
