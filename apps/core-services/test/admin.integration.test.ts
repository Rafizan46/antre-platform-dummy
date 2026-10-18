// S11 Super Admin console (FR-ADMIN-01) on the antre_platform_admin pool: cross-tenant reads for
// SUPER_ADMIN only, and suspension of a tenant or a location with its effect on the tenant routes,
// the WhatsApp internal routes, and new tickets.
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth/password.js';
import {
  apiRequest,
  bearer,
  createClock,
  createMigratorPool,
  createTestApp,
  DEFAULT_CLOCK_ISO,
  DEFAULT_PASSWORD,
  internalHeaders,
  login,
  queryInTenant,
  setupQueueFixture,
  type QueueFixture,
  type TestApp,
} from './helpers.js';

const clock = createClock(DEFAULT_CLOCK_ISO);
let ctx: TestApp;
let migrator: pg.Pool;
let admin: Record<string, string>;
let a: QueueFixture;
let b: QueueFixture;

interface AdminLocation {
  id: string;
  suspended: boolean;
  plan_code: string;
  subscription_status: string;
  usage: { period_month: string; ticket_count: number; monthly_ticket_quota: number | null };
  history?: { period_month: string; ticket_count: number }[];
}
interface AdminTenant {
  id: string;
  slug: string;
  suspended: boolean;
  locations: AdminLocation[];
}

beforeAll(async () => {
  ctx = await createTestApp({ now: clock.now });
  migrator = createMigratorPool();
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  await migrator.query(
    `INSERT INTO users (tenant_id, email, password_hash, role) VALUES (NULL, $1, $2, 'SUPER_ADMIN')`,
    [email, await hashPassword(DEFAULT_PASSWORD)],
  );
  admin = bearer(await login(ctx.app, email, DEFAULT_PASSWORD));
  a = await setupQueueFixture(ctx);
  b = await setupQueueFixture(ctx);
  await queryInTenant(
    ctx.pool,
    a.tenant.tenantId,
    `INSERT INTO usage_counters (tenant_id, location_id, period_month, ticket_count)
     VALUES ($1, $2, '2026-09-01', 40), ($1, $2, '2026-10-01', 85)`,
    [a.tenant.tenantId, a.locationId],
  );
});

afterAll(async () => {
  await ctx.close();
  await migrator.end();
});

beforeEach(() => {
  clock.set(DEFAULT_CLOCK_ISO);
});

function api(method: 'GET' | 'POST', url: string, headers: Record<string, string>) {
  return apiRequest(ctx.app, method, url, headers);
}

function staffTicket(f: QueueFixture) {
  return apiRequest(ctx.app, 'POST', '/api/v1/queues/tickets', f.owner, {
    location_id: f.locationId,
    service_id: f.serviceId,
    customer_name: 'Budi',
  });
}

function waTicket(f: QueueFixture, phone: string) {
  return apiRequest(
    ctx.app,
    'POST',
    '/internal/v1/queues/tickets',
    internalHeaders(ctx, f.tenant.tenantId),
    { location_id: f.locationId, service_id: f.serviceId, customer_phone: phone },
  );
}

describe('access', () => {
  it('is SUPER_ADMIN only: tenant roles get 403, no token 401', async () => {
    for (const headers of [a.owner, a.caller, a.cashier]) {
      for (const url of [
        '/api/v1/admin/tenants',
        `/api/v1/admin/tenants/${b.tenant.tenantId}`,
        '/api/v1/admin/usage',
      ]) {
        const refused = await api('GET', url, headers);
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error.code).toBe('FORBIDDEN');
      }
      expect(
        (await api('POST', `/api/v1/admin/tenants/${b.tenant.tenantId}/suspend`, headers))
          .statusCode,
      ).toBe(403);
    }
    expect((await api('GET', '/api/v1/admin/tenants', {})).statusCode).toBe(401);
    // And SUPER_ADMIN stays out of the tenant routes, billing included.
    const billing = await api(
      'GET',
      `/api/v1/billing/locations/${a.locationId}/subscription`,
      admin,
    );
    expect(billing.statusCode).toBe(403);
  });
});

describe('reads across tenants', () => {
  it('lists tenants with locations, plan, status, and usage of the month', async () => {
    const response = await api('GET', '/api/v1/admin/tenants?limit=100', admin);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ total: number; tenants: AdminTenant[] }>();
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.tenants.length).toBe(Math.min(body.total, 100));

    const detail = await api('GET', `/api/v1/admin/tenants/${a.tenant.tenantId}`, admin);
    expect(detail.statusCode).toBe(200);
    const tenant = detail.json<AdminTenant>();
    expect(tenant).toMatchObject({ id: a.tenant.tenantId, slug: a.tenant.slug, suspended: false });
    expect(tenant.locations).toHaveLength(1);
    expect(tenant.locations[0]).toMatchObject({
      id: a.locationId,
      plan_code: 'FREE',
      subscription_status: 'ACTIVE',
      suspended: false,
      usage: { period_month: '2026-10-01', ticket_count: 85, monthly_ticket_quota: 100 },
      history: [
        { period_month: '2026-10-01', ticket_count: 85 },
        { period_month: '2026-09-01', ticket_count: 40 },
      ],
    });
    // No PII of the tenant (admin WhatsApp number) in the console.
    expect(detail.body).not.toContain('6281234567890');

    const usage = await api('GET', '/api/v1/admin/usage?period_month=2026-09-01', admin);
    const rows = usage.json<{ locations: { location_id: string; ticket_count: number }[] }>()
      .locations;
    expect(rows.find((row) => row.location_id === a.locationId)?.ticket_count).toBe(40);
    expect(rows.find((row) => row.location_id === b.locationId)?.ticket_count).toBe(0);

    expect((await api('GET', `/api/v1/admin/tenants/${randomUUID()}`, admin)).statusCode).toBe(404);
    expect(
      (await api('GET', '/api/v1/admin/usage?period_month=2026-09-15', admin)).statusCode,
    ).toBe(400);
  });
});

describe('suspension (S11)', () => {
  it('suspends a tenant: owner and staff refused, WhatsApp gets no new tickets, B unaffected', async () => {
    const suspend = await api('POST', `/api/v1/admin/tenants/${a.tenant.tenantId}/suspend`, admin);
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json()).toMatchObject({ id: a.tenant.tenantId, suspended: true });

    for (const headers of [a.owner, a.caller]) {
      const refused = await api('GET', '/api/v1/locations', headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toMatchObject({
        code: 'FORBIDDEN',
        details: { reason: 'TENANT_SUSPENDED' },
      });
    }
    const wa = await waTicket(a, '6281299990001');
    expect(wa.statusCode).toBe(409);
    expect(wa.json().error).toMatchObject({
      code: 'LOCATION_CLOSED',
      details: { reason: 'SUSPENDED' },
    });
    const context = await apiRequest(
      ctx.app,
      'GET',
      `/internal/v1/locations/${a.locationId}/wa-context`,
      internalHeaders(ctx, a.tenant.tenantId),
    );
    expect(context.json().location.is_active).toBe(false);

    expect((await api('GET', '/api/v1/locations', b.owner)).statusCode).toBe(200);
    expect((await staffTicket(b)).statusCode).toBe(201);

    const list = await api('GET', '/api/v1/admin/tenants?status=suspended&limit=100', admin);
    const ids = list.json<{ tenants: AdminTenant[] }>().tenants.map((t) => t.id);
    expect(ids).toContain(a.tenant.tenantId);
    expect(ids).not.toContain(b.tenant.tenantId);

    const activate = await api(
      'POST',
      `/api/v1/admin/tenants/${a.tenant.tenantId}/activate`,
      admin,
    );
    expect(activate.json()).toMatchObject({ suspended: false, suspended_at: null });
    expect((await api('GET', '/api/v1/locations', a.owner)).statusCode).toBe(200);
    expect((await waTicket(a, '6281299990001')).statusCode).toBe(201);
  });

  it('suspends one location: no new tickets there, the tenant keeps working', async () => {
    const suspend = await api('POST', `/api/v1/admin/locations/${b.locationId}/suspend`, admin);
    expect(suspend.statusCode).toBe(200);
    const refused = await staffTicket(b);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toEqual({ reason: 'SUSPENDED' });
    expect((await api('GET', '/api/v1/locations', b.owner)).statusCode).toBe(200);

    const detail = (
      await api('GET', `/api/v1/admin/tenants/${b.tenant.tenantId}`, admin)
    ).json<AdminTenant>();
    expect(detail.suspended).toBe(false);
    expect(detail.locations[0]?.suspended).toBe(true);

    await api('POST', `/api/v1/admin/locations/${b.locationId}/activate`, admin);
    expect((await staffTicket(b)).statusCode).toBe(201);
    expect(
      (await api('POST', `/api/v1/admin/locations/${randomUUID()}/suspend`, admin)).statusCode,
    ).toBe(404);
  });
});
