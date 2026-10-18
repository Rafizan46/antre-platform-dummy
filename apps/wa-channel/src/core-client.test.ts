import { describe, expect, it } from 'vitest';

import { CoreApiError, CoreClient, CoreUnavailableError } from './core-client.js';

const TENANT = 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1';
const LOCATION = '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90';
const TOKEN = 'service-token-0123456789-0123456789';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function client(respond: (request: Recorded) => Response | Promise<Response>, timeoutMs = 1000) {
  const requests: Recorded[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    requests.push(request);
    if (init?.signal) {
      // Mirror fetch: reject when the timeout signal aborts first.
      return Promise.race([
        respond(request),
        new Promise<never>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      ]);
    }
    return respond(request);
  }) as typeof fetch;
  return {
    requests,
    api: new CoreClient({
      baseUrl: 'http://core.test/',
      serviceToken: TOKEN,
      timeoutMs,
      fetch: fake,
    }),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('CoreClient', () => {
  it('sends the service token and the tenant header to /internal/v1', async () => {
    const { api, requests } = client(() =>
      json(201, {
        id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
        location_id: LOCATION,
        service_id: LOCATION,
        service_name: 'Umum',
        resource_name: null,
        ticket_number: 'A-001',
        customer_name: 'Budi',
        customer_phone: '6281234567890',
        status: 'WAITING',
        people_ahead: 0,
        estimated_serve_time: null,
        channel: 'WHATSAPP',
      }),
    );
    const ticket = await api.createTicket(TENANT, {
      location_id: LOCATION,
      service_id: LOCATION,
      customer_phone: '6281234567890',
      customer_name: 'Budi',
    });
    expect(ticket.ticket_number).toBe('A-001');
    expect(requests[0]).toMatchObject({
      url: 'http://core.test/internal/v1/queues/tickets',
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-antre-tenant-id': TENANT,
        'content-type': 'application/json',
      },
      body: { location_id: LOCATION, customer_phone: '6281234567890' },
    });
  });

  it('calls the tenantless endpoints without X-Antre-Tenant-Id', async () => {
    const { api, requests } = client((request) =>
      request.url.includes('resolve')
        ? json(200, { tenant_id: TENANT, location_id: LOCATION })
        : json(200, {
            items: [
              { kind: 'TICKET', tenant_id: TENANT, location_id: LOCATION, item_id: LOCATION },
            ],
          }),
    );
    expect(await api.resolveLocation('klinik-sehat', 'pusat')).toEqual({
      tenant_id: TENANT,
      location_id: LOCATION,
    });
    expect(await api.activeItems('6281234567890')).toHaveLength(1);
    expect(requests.map((request) => request.url)).toEqual([
      'http://core.test/internal/v1/locations/resolve?slug=klinik-sehat&code=pusat',
      'http://core.test/internal/v1/customers/active-items?customer_phone=6281234567890',
    ]);
    expect(requests.every((request) => !('x-antre-tenant-id' in request.headers))).toBe(true);
  });

  it('turns 404/400 of resolve into null', async () => {
    const notFound = client(() => json(404, { error: { code: 'NOT_FOUND', message: 'x' } }));
    expect(await notFound.api.resolveLocation('a', 'b')).toBeNull();
    const invalid = client(() => json(400, { error: { code: 'VALIDATION_ERROR', message: 'x' } }));
    expect(await invalid.api.resolveLocation('a', 'b')).toBeNull();
  });

  it('maps an answered 4xx to CoreApiError with code and details', async () => {
    const { api } = client(() =>
      json(409, {
        error: { code: 'ACTIVE_TICKET_EXISTS', message: 'aktif', details: { ticket: { id: 'x' } } },
      }),
    );
    const error = await api
      .createTicket(TENANT, {
        location_id: LOCATION,
        service_id: LOCATION,
        customer_phone: '6281234567890',
        customer_name: 'Budi',
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoreApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'ACTIVE_TICKET_EXISTS',
      details: { ticket: { id: 'x' } },
    });
  });

  it('treats 5xx, 401, timeouts, network errors, and bad bodies as unavailable', async () => {
    const phone = '6281234567890';
    const cases: (() => Response | Promise<Response>)[] = [
      () => json(503, { error: { code: 'INTERNAL_ERROR', message: 'x' } }),
      () => json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }),
      () => json(409, { unexpected: true }),
      () => json(200, { ticket: { id: 'not-a-uuid' } }),
      () => new Response('<html>', { status: 200 }),
      () => Promise.reject(new TypeError('fetch failed')),
      () => new Promise<Response>(() => undefined),
    ];
    for (const respond of cases) {
      const { api } = client(respond, 50);
      const error = await api
        .activeTicket(TENANT, LOCATION, phone)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CoreUnavailableError);
      // The phone number (query string) never ends up in the error message.
      expect((error as Error).message).not.toContain(phone);
    }
  });
});
