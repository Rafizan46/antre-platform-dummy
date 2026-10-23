// Journey (a): an owner sets up a business from nothing, step by step, through the public API.
import { describe, expect, it } from 'vitest';

import { api } from '../src/api.js';
import { stack } from '../src/stack.js';
import { ALL_DAY_HOURS, randomSuffix } from '../src/tenant.js';
import { openStream } from '../src/sse.js';

describe('owner onboarding', () => {
  const suffix = randomSuffix();
  const slug = `onboard-${suffix}`;
  const email = `owner@${slug}.test`;
  const password = `Sup3rSecret-${suffix}`;
  const state: {
    tenantId?: string;
    locationId?: string;
    token?: string;
    freeServiceId?: string;
    dpServiceId?: string;
    resourceId?: string;
    callerToken?: string;
    cashierToken?: string;
  } = {};

  it('registers a tenant with its first location and owner', async () => {
    const response = await api('POST', '/api/v1/auth/register', {
      body: {
        tenant: {
          name: 'Klinik Onboarding',
          slug,
          business_type: 'CLINIC',
          admin_wa_phone: '6281234567890',
        },
        location: { name: 'Pusat', code: 'pusat' },
        owner: { email, password },
      },
    });
    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('OWNER');
    state.tenantId = response.body.tenant.id;
    state.locationId = response.body.location.id;

    const duplicate = await api('POST', '/api/v1/auth/register', {
      body: {
        tenant: {
          name: 'Klinik Lain',
          slug,
          business_type: 'CLINIC',
          admin_wa_phone: '6281234567890',
        },
        location: { name: 'Pusat', code: 'pusat' },
        owner: { email: `other@${slug}.test`, password },
      },
    });
    expect(duplicate.status).toBe(409);
  });

  it('logs in; a wrong password is refused without saying which part was wrong', async () => {
    const wrong = await api('POST', '/api/v1/auth/login', {
      body: { email, password: 'wrong-password-1' },
    });
    expect(wrong.status).toBe(401);
    const unknown = await api('POST', '/api/v1/auth/login', {
      body: { email: `nobody@${slug}.test`, password: 'wrong-password-1' },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);

    const login = await api('POST', '/api/v1/auth/login', { body: { email, password } });
    expect(login.status).toBe(200);
    expect(login.body.access_token.split('.')).toHaveLength(3);
    state.token = login.body.access_token;
  });

  it('creates a service without a down payment and one with a down payment', async () => {
    const free = await api('POST', '/api/v1/catalog/services', {
      token: state.token,
      body: { name: 'Konsultasi', ticket_prefix: 'A', avg_duration_min: 15 },
    });
    expect(free.status).toBe(201);
    state.freeServiceId = free.body.id;

    const dp = await api('POST', '/api/v1/catalog/services', {
      token: state.token,
      body: {
        name: 'Perawatan',
        ticket_prefix: 'B',
        avg_duration_min: 30,
        price: 100_000,
        requires_dp: true,
        dp_amount: 50_000,
      },
    });
    expect(dp.status).toBe(201);
    state.dpServiceId = dp.body.id;

    // A down payment service without an amount is a validation error, not a half-made service.
    const invalid = await api('POST', '/api/v1/catalog/services', {
      token: state.token,
      body: { name: 'Rusak', ticket_prefix: 'C', avg_duration_min: 30, requires_dp: true },
    });
    expect(invalid.status).toBe(400);

    const list = await api('GET', '/api/v1/catalog/services', { token: state.token });
    expect(list.status).toBe(200);
    const names = (list.body.services ?? list.body).map(
      (service: { name: string }) => service.name,
    );
    expect(names).toEqual(expect.arrayContaining(['Konsultasi', 'Perawatan']));
    expect(names).not.toContain('Rusak');
  });

  it('creates a resource linked to both services, and opening hours all day', async () => {
    const resource = await api('POST', '/api/v1/catalog/resources', {
      token: state.token,
      body: {
        location_id: state.locationId,
        name: 'Dokter 1',
        service_ids: [state.freeServiceId, state.dpServiceId],
      },
    });
    expect(resource.status).toBe(201);
    state.resourceId = resource.body.id;

    const hours = await api(
      'PUT',
      `/api/v1/catalog/locations/${state.locationId}/operating-hours`,
      {
        token: state.token,
        body: ALL_DAY_HOURS,
      },
    );
    expect(hours.status).toBe(200);
    const read = await api('GET', `/api/v1/catalog/locations/${state.locationId}/operating-hours`, {
      token: state.token,
    });
    expect(read.status).toBe(200);
    expect(read.body.days).toHaveLength(7);
  });

  it('switches the service mode to BOTH', async () => {
    const response = await api('PATCH', '/api/v1/tenants/me/settings', {
      token: state.token,
      body: { service_mode: 'BOTH', show_wait_estimate: true },
    });
    expect(response.status).toBe(200);
    const settings = await api('GET', '/api/v1/tenants/me/settings', { token: state.token });
    expect(settings.body.service_mode).toBe('BOTH');
  });

  it('creates a caller and a cashier who can log in, with the right limits', async () => {
    const make = async (role: string, name: string) => {
      const created = await api('POST', '/api/v1/users', {
        token: state.token,
        body: { email: `${name}@${slug}.test`, password: `${name}-Pass-123`, role },
      });
      expect(created.status).toBe(201);
      const login = await api('POST', '/api/v1/auth/login', {
        body: { email: `${name}@${slug}.test`, password: `${name}-Pass-123` },
      });
      expect(login.status).toBe(200);
      return login.body.access_token as string;
    };
    state.callerToken = await make('STAFF_CALLER', 'caller');
    state.cashierToken = await make('STAFF_CASHIER', 'cashier');

    // Staff cannot manage the catalog or other users; only the owner can.
    for (const token of [state.callerToken, state.cashierToken]) {
      const catalog = await api('POST', '/api/v1/catalog/services', {
        token,
        body: { name: 'Curang', ticket_prefix: 'Z', avg_duration_min: 10 },
      });
      expect(catalog.status).toBe(403);
    }
    // The cashier cannot call the next customer; the caller can read the queue.
    const callNext = await api('POST', '/api/v1/queues/tickets/call-next', {
      token: state.cashierToken,
      body: {
        location_id: state.locationId,
        service_id: state.freeServiceId,
        resource_id: state.resourceId,
      },
    });
    expect(callNext.status).toBe(403);
    const queue = await api('GET', `/api/v1/queues/tickets?location_id=${state.locationId}`, {
      token: state.callerToken,
    });
    expect(queue.status).toBe(200);
  });

  it('issues a kiosk token that opens the realtime stream but is useless on the staff API', async () => {
    const kiosk = await api('POST', `/api/v1/locations/${state.locationId}/kiosk-tokens`, {
      token: state.token,
    });
    expect(kiosk.status).toBe(201);
    const token: string = kiosk.body.token;

    const stream = await openStream(stack().realtimeUrl, state.locationId!, token);
    try {
      expect(stream.status).toBe(200);
      await stream.waitFor((message) => message.event === 'snapshot', 'snapshot');
    } finally {
      stream.close();
    }

    const staffApi = await api('GET', '/api/v1/catalog/services', { token });
    expect([401, 403]).toContain(staffApi.status);
    const tickets = await api('GET', `/api/v1/queues/tickets?location_id=${state.locationId}`, {
      token,
    });
    expect([401, 403]).toContain(tickets.status);
  });
});
