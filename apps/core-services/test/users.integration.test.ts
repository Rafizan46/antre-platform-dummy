import { randomUUID } from 'node:crypto';

import type { UserDto } from '@antre/shared-types';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearer, createTestApp, login, registerTenant, type TestApp } from './helpers.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.close();
});

const PASSWORD = 'staff-password-1';

function request(method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: object) {
  return ctx.app.inject({ method, url, headers: bearer(token), payload });
}

async function ownerSession() {
  const tenant = await registerTenant(ctx.app);
  const token = await login(ctx.app, tenant.ownerEmail, tenant.password);
  return { tenant, token };
}

async function createStaff(
  app: FastifyInstance,
  ownerToken: string,
  role: 'STAFF_CALLER' | 'STAFF_CASHIER' = 'STAFF_CALLER',
) {
  const email = `staff-${randomUUID().slice(0, 8)}@example.test`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: bearer(ownerToken),
    payload: { email, password: PASSWORD, role },
  });
  expect(response.statusCode).toBe(201);
  return { email, user: response.json<UserDto>() };
}

describe('staff management', () => {
  it('lets the owner create staff who can log in (1)', async () => {
    const { tenant, token } = await ownerSession();
    const caller = await createStaff(ctx.app, token, 'STAFF_CALLER');
    await createStaff(ctx.app, token, 'STAFF_CASHIER');
    expect(caller.user).toMatchObject({ role: 'STAFF_CALLER', is_active: true });

    const list = await request('GET', '/api/v1/users', token);
    expect(list.statusCode).toBe(200);
    const users = list.json<{ users: UserDto[] }>().users;
    expect(users).toHaveLength(3);
    expect(users.map((user) => user.role)).toContain('OWNER');
    expect(users.some((user) => user.id === tenant.ownerId)).toBe(true);

    const staffToken = await login(ctx.app, caller.email, PASSWORD);
    expect(staffToken).toBeTruthy();
  });

  it('limits what staff may do (2)', async () => {
    const { token } = await ownerSession();
    const staff = await createStaff(ctx.app, token);
    const staffToken = await login(ctx.app, staff.email, PASSWORD);

    expect((await request('GET', '/api/v1/users', staffToken)).statusCode).toBe(403);
    expect(
      (
        await request('POST', '/api/v1/users', staffToken, {
          email: `x-${randomUUID().slice(0, 8)}@example.test`,
          password: PASSWORD,
          role: 'STAFF_CALLER',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request('PATCH', '/api/v1/tenants/me/settings', staffToken, {
          show_wait_estimate: false,
        })
      ).statusCode,
    ).toBe(403);
    expect((await request('GET', '/api/v1/tenants/me/settings', staffToken)).statusCode).toBe(200);
  });

  it('staff cannot patch the owner or another staff member (2b)', async () => {
    const { tenant, token } = await ownerSession();
    const first = await createStaff(ctx.app, token);
    const second = await createStaff(ctx.app, token);
    const staffToken = await login(ctx.app, first.email, PASSWORD);

    for (const id of [tenant.ownerId, second.user.id]) {
      const response = await request('PATCH', `/api/v1/users/${id}`, staffToken, {
        is_active: false,
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('rejects OWNER and SUPER_ADMIN as roles on create (3)', async () => {
    const { token } = await ownerSession();
    for (const role of ['OWNER', 'SUPER_ADMIN']) {
      const response = await request('POST', '/api/v1/users', token, {
        email: `x-${randomUUID().slice(0, 8)}@example.test`,
        password: PASSWORD,
        role,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects an email owned by another tenant (4)', async () => {
    const { token } = await ownerSession();
    const other = await registerTenant(ctx.app);
    const response = await request('POST', '/api/v1/users', token, {
      email: other.ownerEmail,
      password: PASSWORD,
      role: 'STAFF_CALLER',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'ALREADY_EXISTS',
      details: { field: 'email' },
    });
  });

  it('deactivation takes effect immediately and can be undone (5)', async () => {
    const { token } = await ownerSession();
    const staff = await createStaff(ctx.app, token);
    const staffToken = await login(ctx.app, staff.email, PASSWORD);
    const settingsUrl = '/api/v1/tenants/me/settings';
    expect((await request('GET', settingsUrl, staffToken)).statusCode).toBe(200);

    const off = await request('PATCH', `/api/v1/users/${staff.user.id}`, token, {
      is_active: false,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json<UserDto>().is_active).toBe(false);

    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: staff.email, password: PASSWORD },
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe('INVALID_CREDENTIALS');

    const oldToken = await request('GET', settingsUrl, staffToken);
    expect(oldToken.statusCode).toBe(401);
    expect(oldToken.json().error.code).toBe('UNAUTHORIZED');

    await request('PATCH', `/api/v1/users/${staff.user.id}`, token, { is_active: true });
    expect(await login(ctx.app, staff.email, PASSWORD)).toBeTruthy();
  });

  it('a role change invalidates old tokens (6)', async () => {
    const { token } = await ownerSession();
    const staff = await createStaff(ctx.app, token, 'STAFF_CALLER');
    const oldToken = await login(ctx.app, staff.email, PASSWORD);

    const changed = await request('PATCH', `/api/v1/users/${staff.user.id}`, token, {
      role: 'STAFF_CASHIER',
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<UserDto>().role).toBe('STAFF_CASHIER');

    expect((await request('GET', '/api/v1/tenants/me/settings', oldToken)).statusCode).toBe(401);
    const newToken = await login(ctx.app, staff.email, PASSWORD);
    expect((await request('GET', '/api/v1/tenants/me/settings', newToken)).statusCode).toBe(200);
  });

  it('a password reset replaces the password (7)', async () => {
    const { token } = await ownerSession();
    const staff = await createStaff(ctx.app, token);

    const reset = await request('PATCH', `/api/v1/users/${staff.user.id}`, token, {
      password: 'brand-new-password',
    });
    expect(reset.statusCode).toBe(200);

    const attempt = (password: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: staff.email, password },
      });
    expect((await attempt(PASSWORD)).statusCode).toBe(401);
    expect((await attempt('brand-new-password')).statusCode).toBe(200);
  });

  it('refuses to patch the owner account and bad roles (8)', async () => {
    const { tenant, token } = await ownerSession();
    const staff = await createStaff(ctx.app, token);

    const owner = await request('PATCH', `/api/v1/users/${tenant.ownerId}`, token, {
      is_active: false,
    });
    expect(owner.statusCode).toBe(403);

    for (const role of ['OWNER', 'SUPER_ADMIN']) {
      const response = await request('PATCH', `/api/v1/users/${staff.user.id}`, token, { role });
      expect(response.statusCode).toBe(400);
    }
    expect((await request('PATCH', `/api/v1/users/${staff.user.id}`, token, {})).statusCode).toBe(
      400,
    );
  });

  it('isolates tenants (9)', async () => {
    const a = await ownerSession();
    const b = await ownerSession();
    const staffA = await createStaff(ctx.app, a.token);

    const patched = await request('PATCH', `/api/v1/users/${staffA.user.id}`, b.token, {
      is_active: false,
    });
    expect(patched.statusCode).toBe(404);

    const listA = await request('GET', '/api/v1/users', a.token);
    const entry = listA.json<{ users: UserDto[] }>().users.find((u) => u.id === staffA.user.id);
    expect(entry?.is_active).toBe(true);

    const listB = await request('GET', '/api/v1/users', b.token);
    const idsB = listB.json<{ users: UserDto[] }>().users.map((user) => user.id);
    expect(idsB).toEqual([b.tenant.ownerId]);

    const badId = await request('PATCH', '/api/v1/users/not-a-uuid', b.token, { is_active: false });
    expect(badId.statusCode).toBe(404);
  });
});
