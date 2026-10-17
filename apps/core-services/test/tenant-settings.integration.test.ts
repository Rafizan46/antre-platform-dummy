import type { TenantSettingsDto } from '@antre/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createTestApp, login, registerTenant, type TestApp } from './helpers.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

const SETTINGS_URL = '/api/v1/tenants/me/settings';

async function ownerSession() {
  const tenant = await registerTenant(ctx.app);
  const token = await login(ctx.app, tenant.ownerEmail, tenant.password);
  return { tenant, token };
}

const get = (token: string) =>
  ctx.app.inject({ method: 'GET', url: SETTINGS_URL, headers: bearer(token) });
const patch = (token: string, payload: object) =>
  ctx.app.inject({ method: 'PATCH', url: SETTINGS_URL, headers: bearer(token), payload });

describe('tenant settings', () => {
  it('lets the owner change mode, estimate, admin phone, and branding (1)', async () => {
    const { token } = await ownerSession();
    const branding = {
      logo_url: 'https://cdn.example.test/logo.png',
      accent_color: '#1A73E8',
      labels: { resource: 'Dokter', ticket: 'Nomor' },
      wa_greeting: 'Selamat datang di klinik kami',
    };

    const updated = await patch(token, {
      service_mode: 'RESERVATION',
      show_wait_estimate: false,
      admin_wa_phone: '6289876543210',
      branding,
    });
    expect(updated.statusCode).toBe(200);

    const fetched = await get(token);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<TenantSettingsDto>()).toMatchObject({
      service_mode: 'RESERVATION',
      show_wait_estimate: false,
      admin_wa_phone: '6289876543210',
      branding,
    });
    expect(updated.json()).toEqual(fetched.json());
  });

  it('replaces branding as a whole and keeps untouched fields', async () => {
    const { token } = await ownerSession();
    await patch(token, { branding: { accent_color: '#112233', wa_greeting: 'Halo' } });
    const second = await patch(token, { branding: { accent_color: '#445566' } });

    expect(second.statusCode).toBe(200);
    const body = second.json<TenantSettingsDto>();
    expect(body.branding).toEqual({ accent_color: '#445566' });
    expect(body.service_mode).toBe('BOTH');
    expect(body.show_wait_estimate).toBe(true);
  });

  it('rejects invalid input with 400 (2)', async () => {
    const { token } = await ownerSession();
    const bodies = [
      { branding: { accent_color: 'red' } },
      { branding: { logo_url: 'http://cdn.example.test/logo.png' } },
      { branding: { font: 'serif' } },
      { name: 'Renamed' },
      {},
    ];
    for (const body of bodies) {
      const response = await patch(token, body);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('isolates tenants (3)', async () => {
    const a = await ownerSession();
    const b = await ownerSession();

    const before = (await get(b.token)).json<TenantSettingsDto>();
    expect(before.slug).toBe(b.tenant.slug);
    expect(before.id).toBe(b.tenant.tenantId);

    await patch(a.token, { service_mode: 'WALK_IN', show_wait_estimate: false });

    const after = (await get(b.token)).json<TenantSettingsDto>();
    expect(after).toEqual(before);
    expect((await get(a.token)).json<TenantSettingsDto>().slug).toBe(a.tenant.slug);
  });
});
