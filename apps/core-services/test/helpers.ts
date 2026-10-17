// Shared helpers for the API integration tests: an app on the antre_app pool, tenant registration
// and login through the real HTTP routes, and reads in a tenant context.
import { randomUUID } from 'node:crypto';

import type { EventEnvelope } from '@antre/event-contracts';
import type { LocationDto, RegisterResponse } from '@antre/shared-types';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemorySlotLock, RedisSlotLock, type SlotLock } from '../src/booking/slot-lock.js';
import { withTransaction } from '../src/db/transaction.js';
import { InMemoryEventPublisher } from '../src/events/publisher.js';

export const DEFAULT_PASSWORD = 'password-ok-123';

export interface TestApp {
  app: FastifyInstance;
  /** Pool of the antre_app role, the same one the app uses. */
  pool: pg.Pool;
  jwtSecret: string;
  /** Service token of the WhatsApp Channel Service for /internal/v1. */
  waChannelToken: string;
  /** HMAC secret of the QRIS payment callback. */
  paymentCallbackSecret: string;
  /** The slot lock the app uses (in memory unless a test passes another). */
  slotLock: SlotLock;
  /** Events published after commits. */
  events: InMemoryEventPublisher;
  close: () => Promise<void>;
}

export async function createTestApp(
  options: { now?: () => Date; slotLock?: SlotLock } = {},
): Promise<TestApp> {
  const urls = inject('databaseUrls');
  const pool = new pg.Pool({ connectionString: urls.app, max: 10 });
  const { jwtSecret, waChannelToken, paymentCallbackSecret } = loadConfig({
    ...process.env,
    DATABASE_APP_URL: urls.app,
  });
  const events = new InMemoryEventPublisher();
  const slotLock = options.slotLock ?? new InMemorySlotLock();
  const app = buildApp({
    pool,
    jwtSecret,
    waChannelToken,
    slotLock,
    paymentCallbackSecret,
    events,
    now: options.now,
  });
  await app.ready();
  return {
    app,
    pool,
    jwtSecret,
    waChannelToken,
    paymentCallbackSecret,
    slotLock,
    events,
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

/** Headers of the WhatsApp Channel Service for /internal/v1. */
export function internalHeaders(ctx: TestApp, tenantId: string): Record<string, string> {
  return { authorization: `Bearer ${ctx.waChannelToken}`, 'x-antre-tenant-id': tenantId };
}

/** A mutable clock for the app: `set` and `advance` move the time the services see. */
export function createClock(iso: string) {
  let current = new Date(iso);
  return {
    now: (): Date => new Date(current),
    set(next: string): void {
      current = new Date(next);
    },
    advance(milliseconds: number): void {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}
export type TestClock = ReturnType<typeof createClock>;

/** Default test time: 2026-10-19 10:00 in Asia/Jakarta (a Monday). */
export const DEFAULT_CLOCK_ISO = '2026-10-19T03:00:00Z';

export async function apiRequest(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  headers: Record<string, string>,
  payload?: object,
) {
  return app.inject({ method, url, headers, payload });
}

export const ALL_WEEK = Array.from({ length: 7 }, (_, day_of_week) => ({
  day_of_week,
  open_time: '00:00',
  close_time: '23:59',
}));

export interface QueueFixture {
  tenant: RegisteredTenant;
  locationId: string;
  serviceId: string;
  resourceId: string;
  /** Bearer headers; call refreshTokens() after moving the clock by hours. */
  owner: Record<string, string>;
  caller: Record<string, string>;
  cashier: Record<string, string>;
  refreshTokens: () => Promise<void>;
}

/**
 * A tenant with one location open all week 00:00-23:59, service A (10 min) served by one resource,
 * and an owner, a caller, and a cashier session.
 */
export async function setupQueueFixture(ctx: TestApp): Promise<QueueFixture> {
  const tenant = await registerTenant(ctx.app);
  const callerEmail = `caller-${randomUUID().slice(0, 8)}@example.test`;
  const cashierEmail = `cashier-${randomUUID().slice(0, 8)}@example.test`;

  const loginAll = async () => ({
    owner: bearer(await login(ctx.app, tenant.ownerEmail, tenant.password)),
    caller: bearer(await login(ctx.app, callerEmail, DEFAULT_PASSWORD)),
    cashier: bearer(await login(ctx.app, cashierEmail, DEFAULT_PASSWORD)),
  });

  const ownerHeaders = bearer(await login(ctx.app, tenant.ownerEmail, tenant.password));
  for (const [role, email] of [
    ['STAFF_CALLER', callerEmail],
    ['STAFF_CASHIER', cashierEmail],
  ] as const) {
    const response = await apiRequest(ctx.app, 'POST', '/api/v1/users', ownerHeaders, {
      email,
      password: DEFAULT_PASSWORD,
      role,
    });
    if (response.statusCode !== 201) throw new Error(`staff failed: ${response.body}`);
  }

  const locations = await apiRequest(ctx.app, 'GET', '/api/v1/locations', ownerHeaders);
  const locationId = locations.json<{ locations: LocationDto[] }>().locations[0]!.id;

  const hours = await apiRequest(
    ctx.app,
    'PUT',
    `/api/v1/catalog/locations/${locationId}/operating-hours`,
    ownerHeaders,
    { slot_interval_min: 30, days: ALL_WEEK },
  );
  if (hours.statusCode !== 200) throw new Error(`hours failed: ${hours.body}`);

  const service = await apiRequest(ctx.app, 'POST', '/api/v1/catalog/services', ownerHeaders, {
    name: 'Umum',
    ticket_prefix: 'A',
    avg_duration_min: 10,
  });
  if (service.statusCode !== 201) throw new Error(`service failed: ${service.body}`);
  const serviceId = service.json<{ id: string }>().id;

  const resource = await apiRequest(ctx.app, 'POST', '/api/v1/catalog/resources', ownerHeaders, {
    location_id: locationId,
    name: 'Loket 1',
    service_ids: [serviceId],
  });
  if (resource.statusCode !== 201) throw new Error(`resource failed: ${resource.body}`);

  const fixture: QueueFixture = {
    tenant,
    locationId,
    serviceId,
    resourceId: resource.json<{ id: string }>().id,
    ...(await loginAll()),
    refreshTokens: async () => {
      Object.assign(fixture, await loginAll());
    },
  };
  return fixture;
}

/** Events of one type published so far. */
export function eventsOfType(ctx: TestApp, type: EventEnvelope['event_type']): EventEnvelope[] {
  return ctx.events.events.filter((event) => event.event_type === type);
}

/** A Redis slot lock on REDIS_URL (the compose Redis, or the CI service); call close() afterwards. */
export async function redisSlotLock(): Promise<RedisSlotLock> {
  const url = process.env.REDIS_URL;
  if (!url)
    throw new Error('REDIS_URL is not set; run the tests with "pnpm core:test:integration".');
  const lock = new RedisSlotLock({ url, log: { warn: () => {} } });
  await lock.connect();
  return lock;
}

export interface BookingFixture {
  tenant: RegisteredTenant;
  locationId: string;
  /** Service with a 50000 down payment, and one without; both served by both resources. */
  dpServiceId: string;
  freeServiceId: string;
  /** Resources in name order: "Ruang A", "Ruang B". */
  resourceIds: [string, string];
  owner: Record<string, string>;
  caller: Record<string, string>;
  cashier: Record<string, string>;
}

export const DP_AMOUNT = 50000;

/**
 * A tenant in service mode BOTH with one location open all week 00:00-23:59 (60 minute slots),
 * a DP service and a non-DP service, two resources serving both, and owner, caller, and cashier.
 */
export async function setupBookingFixture(ctx: TestApp): Promise<BookingFixture> {
  const tenant = await registerTenant(ctx.app);
  const callerEmail = `caller-${randomUUID().slice(0, 8)}@example.test`;
  const cashierEmail = `cashier-${randomUUID().slice(0, 8)}@example.test`;
  const owner = bearer(await login(ctx.app, tenant.ownerEmail, tenant.password));

  for (const [role, email] of [
    ['STAFF_CALLER', callerEmail],
    ['STAFF_CASHIER', cashierEmail],
  ] as const) {
    const response = await apiRequest(ctx.app, 'POST', '/api/v1/users', owner, {
      email,
      password: DEFAULT_PASSWORD,
      role,
    });
    if (response.statusCode !== 201) throw new Error(`staff failed: ${response.body}`);
  }

  const locations = await apiRequest(ctx.app, 'GET', '/api/v1/locations', owner);
  const locationId = locations.json<{ locations: LocationDto[] }>().locations[0]!.id;

  const hours = await apiRequest(
    ctx.app,
    'PUT',
    `/api/v1/catalog/locations/${locationId}/operating-hours`,
    owner,
    { slot_interval_min: 60, days: ALL_WEEK },
  );
  if (hours.statusCode !== 200) throw new Error(`hours failed: ${hours.body}`);

  const createService = async (body: object): Promise<string> => {
    const response = await apiRequest(ctx.app, 'POST', '/api/v1/catalog/services', owner, body);
    if (response.statusCode !== 201) throw new Error(`service failed: ${response.body}`);
    return response.json<{ id: string }>().id;
  };
  const dpServiceId = await createService({
    name: 'Konsultasi DP',
    ticket_prefix: 'B',
    avg_duration_min: 60,
    requires_dp: true,
    dp_amount: DP_AMOUNT,
  });
  const freeServiceId = await createService({
    name: 'Konsultasi',
    ticket_prefix: 'N',
    avg_duration_min: 60,
  });

  const createResource = async (name: string): Promise<string> => {
    const response = await apiRequest(ctx.app, 'POST', '/api/v1/catalog/resources', owner, {
      location_id: locationId,
      name,
      service_ids: [dpServiceId, freeServiceId],
    });
    if (response.statusCode !== 201) throw new Error(`resource failed: ${response.body}`);
    return response.json<{ id: string }>().id;
  };
  const resourceIds: [string, string] = [
    await createResource('Ruang A'),
    await createResource('Ruang B'),
  ];

  return {
    tenant,
    locationId,
    dpServiceId,
    freeServiceId,
    resourceIds,
    owner,
    caller: bearer(await login(ctx.app, callerEmail, DEFAULT_PASSWORD)),
    cashier: bearer(await login(ctx.app, cashierEmail, DEFAULT_PASSWORD)),
  };
}
