// Shared helpers for the API integration tests: an app on the antre_app pool, tenant registration
// and login through the real HTTP routes, and reads in a tenant context.
import { randomUUID } from 'node:crypto';

import type { RegisterResponse } from '@antre/shared-types';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTransaction } from '../src/db/transaction.js';

export const DEFAULT_PASSWORD = 'password-ok-123';

export interface TestApp {
  app: FastifyInstance;
  /** Pool of the antre_app role, the same one the app uses. */
  pool: pg.Pool;
  jwtSecret: string;
  close: () => Promise<void>;
}

export async function createTestApp(options: { now?: () => Date } = {}): Promise<TestApp> {
  const urls = inject('databaseUrls');
  const pool = new pg.Pool({ connectionString: urls.app, max: 10 });
  const { jwtSecret } = loadConfig({ ...process.env, DATABASE_APP_URL: urls.app });
  const app = buildApp({ pool, jwtSecret, now: options.now });
  await app.ready();
  return {
    app,
    pool,
    jwtSecret,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/** Pool of the antre_migrator role, used to provision SUPER_ADMIN accounts. */
export function createMigratorPool(): pg.Pool {
  return new pg.Pool({ connectionString: inject('databaseUrls').migrator, max: 2 });
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface RegisteredTenant {
  tenantId: string;
  slug: string;
  locationCode: string;
  ownerId: string;
  ownerEmail: string;
  password: string;
}

export function registerBody(overrides: { slug?: string; email?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  return {
    tenant: {
      name: `Tenant ${suffix}`,
      slug: overrides.slug ?? `tenant-${suffix}`,
      business_type: 'CLINIC',
      admin_wa_phone: '6281234567890',
    },
    location: { name: 'Pusat', code: 'pusat' },
    owner: { email: overrides.email ?? `owner-${suffix}@example.test`, password: DEFAULT_PASSWORD },
  };
}

/** Registers a tenant through POST /api/v1/auth/register. */
export async function registerTenant(
  app: FastifyInstance,
  overrides: { slug?: string; email?: string } = {},
): Promise<RegisteredTenant> {
  const body = registerBody(overrides);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: body,
  });
  if (response.statusCode !== 201) {
    throw new Error(`register failed: ${response.statusCode} ${response.body}`);
  }
  const registered = response.json<RegisterResponse>();
  return {
    tenantId: registered.tenant.id,
    slug: registered.tenant.slug,
    locationCode: registered.location.code,
    ownerId: registered.user.id,
    ownerEmail: body.owner.email,
    password: body.owner.password,
  };
}

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ access_token: string }>().access_token;
}

/** Runs `sql` as antre_app in the context of `tenantId` (so RLS applies). */
export async function queryInTenant<Row extends pg.QueryResultRow>(
  pool: pg.Pool,
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  return withTransaction(
    pool,
    tenantId,
    async (client) => (await client.query<Row>(sql, params)).rows,
  );
}
