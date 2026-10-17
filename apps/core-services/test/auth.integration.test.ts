import { randomUUID } from 'node:crypto';

import type { LoginResponse, RegisterResponse } from '@antre/shared-types';
import { SignJWT } from 'jose';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth/password.js';
import { createTokenService } from '../src/auth/tokens.js';
import {
  DEFAULT_PASSWORD,
  bearer,
  createMigratorPool,
  createTestApp,
  login,
  queryInTenant,
  registerBody,
  registerTenant,
  type TestApp,
} from './helpers.js';

let ctx: TestApp;
let migratorPool: pg.Pool;
// Mutable clock shared with the app under test.
let nowMs = Date.now();

beforeAll(async () => {
  ctx = await createTestApp({ now: () => new Date(nowMs) });
  migratorPool = createMigratorPool();
});

afterAll(async () => {
  await migratorPool.end();
  await ctx.close();
});

const post = (url: string, payload: unknown) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object });

describe('POST /api/v1/auth/register', () => {
  it('creates tenant, owner, location, and FREE subscription (1)', async () => {
    const body = registerBody();
    const response = await post('/api/v1/auth/register', body);

    expect(response.statusCode).toBe(201);
    const registered = response.json<RegisterResponse>();
    expect(registered.tenant.slug).toBe(body.tenant.slug);
    expect(registered.location.code).toBe('pusat');
    expect(registered.user).toMatchObject({
      email: body.owner.email,
      role: 'OWNER',
      is_active: true,
    });
    expect(JSON.stringify(registered)).not.toContain('scrypt');

    const tenantId = registered.tenant.id;
    const [tenant] = await queryInTenant<{ service_mode: string; show_wait_estimate: boolean }>(
      ctx.pool,
      tenantId,
      'SELECT service_mode, show_wait_estimate FROM tenants',
    );
    expect(tenant).toEqual({ service_mode: 'BOTH', show_wait_estimate: true });

    const users = await queryInTenant<{ role: string; password_hash: string }>(
      ctx.pool,
      tenantId,
      'SELECT role, password_hash FROM users',
    );
    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe('OWNER');
    expect(users[0]?.password_hash.startsWith('scrypt$')).toBe(true);

    const locations = await queryInTenant(ctx.pool, tenantId, 'SELECT id FROM locations');
    expect(locations).toHaveLength(1);

    const subscriptions = await queryInTenant<{ plan_code: string; status: string }>(
      ctx.pool,
      tenantId,
      'SELECT plan_code, status FROM subscriptions',
    );
    expect(subscriptions).toEqual([{ plan_code: 'FREE', status: 'ACTIVE' }]);
  });

  it('answers duplicates with 409 and leaves nothing behind (2)', async () => {
    const first = await registerTenant(ctx.app);

    const dupSlug = await post('/api/v1/auth/register', registerBody({ slug: first.slug }));
    expect(dupSlug.statusCode).toBe(409);
    expect(dupSlug.json().error).toMatchObject({
      code: 'ALREADY_EXISTS',
      details: { field: 'slug' },
    });

    const slug2 = `second-${randomUUID().slice(0, 8)}`;
    const dupEmail = await post(
      '/api/v1/auth/register',
      registerBody({ slug: slug2, email: first.ownerEmail }),
    );
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.json().error).toMatchObject({
      code: 'ALREADY_EXISTS',
      details: { field: 'email' },
    });

    const resolved = await ctx.pool.query('SELECT * FROM app_resolve_location($1, $2)', [
      slug2,
      'pusat',
    ]);
    expect(resolved.rows).toHaveLength(0);
  });

  it('rejects an invalid body with 400 VALIDATION_ERROR (3)', async () => {
    const body = registerBody();
    const response = await post('/api/v1/auth/register', {
      ...body,
      owner: { ...body.owner, password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/auth/login', () => {
  it('logs in and reaches a protected route (4)', async () => {
    const tenant = await registerTenant(ctx.app);
    const response = await post('/api/v1/auth/login', {
      email: tenant.ownerEmail,
      password: tenant.password,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<LoginResponse>();
    expect(body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 28_800,
      user: { id: tenant.ownerId, role: 'OWNER', tenant_id: tenant.tenantId },
    });

    const claims = await createTokenService({
      secret: ctx.jwtSecret,
      now: () => new Date(nowMs),
    }).verify(body.access_token);
    expect(claims).toEqual({ userId: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER' });

    const settings = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/tenants/me/settings',
      headers: bearer(body.access_token),
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().slug).toBe(tenant.slug);
  });

  it('answers wrong password and unknown email identically (5)', async () => {
    const tenant = await registerTenant(ctx.app);
    const wrong = await post('/api/v1/auth/login', {
      email: tenant.ownerEmail,
      password: 'not-the-password',
    });
    const unknown = await post('/api/v1/auth/login', {
      email: `nobody-${randomUUID()}@example.test`,
      password: 'not-the-password',
    });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('limits to 5 attempts per window, then allows again (6)', async () => {
    const tenant = await registerTenant(ctx.app);
    const attempt = (password: string) =>
      post('/api/v1/auth/login', { email: tenant.ownerEmail, password });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt('wrong-password')).statusCode).toBe(401);
    }
    const blocked = await attempt(tenant.password);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    nowMs += 15 * 60 * 1000 + 1000;
    expect((await attempt(tenant.password)).statusCode).toBe(200);
  });

  it('counts parallel wrong attempts before they finish (6b)', async () => {
    const tenant = await registerTenant(ctx.app);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/api/v1/auth/login', { email: tenant.ownerEmail, password: 'wrong-password' }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });
});

describe('token validation (7)', () => {
  it('rejects missing, malformed, foreign, expired, alg none, and tampered tokens', async () => {
    const tenant = await registerTenant(ctx.app);
    const validToken = await login(ctx.app, tenant.ownerEmail, tenant.password);
    const claims = { userId: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER' as const };

    const foreign = await createTokenService({
      secret: 'another-secret-of-at-least-32-characters-xx',
      now: () => new Date(nowMs),
    }).sign(claims);
    const expired = await createTokenService({
      secret: ctx.jwtSecret,
      now: () => new Date(nowMs - 9 * 60 * 60 * 1000),
    }).sign(claims);

    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const iat = Math.floor(nowMs / 1000);
    const algNone = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: tenant.ownerId,
      tenant_id: tenant.tenantId,
      role: 'OWNER',
      iss: 'antre-auth',
      aud: 'antre-api',
      iat,
      exp: iat + 3600,
    })}.`;

    const [header, payload, signature] = validToken.split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as object;
    const tampered = `${header}.${encode({ ...decoded, role: 'SUPER_ADMIN' })}.${signature}`;

    const hs512 = await new SignJWT({ tenant_id: tenant.tenantId, role: 'OWNER' })
      .setProtectedHeader({ alg: 'HS512', typ: 'JWT' })
      .setSubject(tenant.ownerId)
      .setIssuer('antre-auth')
      .setAudience('antre-api')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(new TextEncoder().encode(ctx.jwtSecret));

    const headersList: (Record<string, string> | undefined)[] = [
      undefined,
      { authorization: 'Bearer abc' },
      { authorization: validToken },
      bearer(foreign.token),
      bearer(expired.token),
      bearer(algNone),
      bearer(tampered),
      bearer(hs512),
    ];
    for (const headers of headersList) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/tenants/me/settings',
        headers,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
    }

    // Sanity: the untouched token still works.
    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/tenants/me/settings',
      headers: bearer(validToken),
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('SUPER_ADMIN (8)', () => {
  it('logs in without tenant but is refused tenant routes', async () => {
    const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
    await migratorPool.query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES (NULL, $1, $2, 'SUPER_ADMIN')`,
      [email, await hashPassword(DEFAULT_PASSWORD)],
    );

    const response = await post('/api/v1/auth/login', { email, password: DEFAULT_PASSWORD });
    expect(response.statusCode).toBe(200);
    const body = response.json<LoginResponse>();
    expect(body.user).toMatchObject({ role: 'SUPER_ADMIN', tenant_id: null });

    for (const url of ['/api/v1/users', '/api/v1/tenants/me/settings']) {
      const refused = await ctx.app.inject({
        method: 'GET',
        url,
        headers: bearer(body.access_token),
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('FORBIDDEN');
    }
  });
});
