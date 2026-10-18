// Embeds the real core services in another package's integration tests (the WA Channel Service,
// S09): buildApp on a given database and Redis, listening on an ephemeral 127.0.0.1 port, with an
// in-memory event publisher so the caller can assert the domain events. Exported as
// "@antre/core-services/testing"; never part of the production bundle (built from src/server.ts).
import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import { buildApp } from '../src/app.js';
import { RedisSlotLock } from '../src/booking/slot-lock.js';
import { loadConfig } from '../src/config.js';
import { FanoutEventPublisher, InMemoryEventPublisher } from '../src/events/publisher.js';
import { RedisRealtime } from '../src/realtime/redis-realtime.js';
import { ALL_WEEK, apiRequest, bearer, login, registerTenant } from './helpers.js';

export interface EmbeddedCoreServices {
  /** Base URL, e.g. http://127.0.0.1:54321 */
  url: string;
  waChannelToken: string;
  paymentCallbackSecret: string;
  jwtSecret: string;
  /** Events published after commits. */
  events: InMemoryEventPublisher;
  pool: pg.Pool;
  /** The Fastify instance (for app.inject in fixtures). */
  app: FastifyInstance;
  close(): Promise<void>;
}

/**
 * Starts the core services. Secrets come from the environment (`.env.example` via the test
 * script); `databaseUrl` is the antre_app URL of the caller's test database.
 */
export async function startCoreServices(options: {
  databaseUrl: string;
  redisUrl: string;
  /**
   * S10: also publish to the realtime Redis path (update log + Pub/Sub) and store kiosk token
   * revocations in Redis, as server.ts does. Default false (in-memory events only).
   */
  realtime?: boolean;
}): Promise<EmbeddedCoreServices> {
  const config = loadConfig({
    ...process.env,
    DATABASE_APP_URL: options.databaseUrl,
    REDIS_URL: options.redisUrl,
  });
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
  const slotLock = new RedisSlotLock({ url: options.redisUrl, log: { warn: () => undefined } });
  await slotLock.connect();
  const events = new InMemoryEventPublisher();
  let realtime: RedisRealtime | undefined;
  if (options.realtime === true) {
    realtime = new RedisRealtime({ url: options.redisUrl, log: { warn: () => undefined } });
    await realtime.connect();
  }
  const app = buildApp({
    pool,
    jwtSecret: config.jwtSecret,
    waChannelToken: config.waChannelToken,
    slotLock,
    paymentCallbackSecret: config.paymentCallbackSecret,
    events: realtime === undefined ? events : new FanoutEventPublisher([events, realtime]),
    ...(realtime === undefined ? {} : { kioskRevocations: realtime }),
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    url: address,
    waChannelToken: config.waChannelToken,
    paymentCallbackSecret: config.paymentCallbackSecret,
    jwtSecret: config.jwtSecret,
    events,
    pool,
    app,
    close: async () => {
      await app.close();
      await slotLock.close();
      await realtime?.close();
      await pool.end();
    },
  };
}

export interface WaFixture {
  tenantId: string;
  tenantName: string;
  slug: string;
  locationCode: string;
  locationId: string;
  /** Walk-in and bookable service without DP ("Poli Umum", prefix A). */
  serviceId: string;
  /** Bookable service with a 50000 DP ("Konsultasi DP", prefix B). */
  dpServiceId: string;
  resourceId: string;
  owner: Record<string, string>;
}

/**
 * A tenant in service mode BOTH with one location open all week 00:00-23:59 (30 minute slots),
 * a service without DP and one with DP, both served by one resource.
 */
export async function setupWaFixture(core: EmbeddedCoreServices): Promise<WaFixture> {
  const app = core.app;
  const tenant = await registerTenant(app);
  const owner = bearer(await login(app, tenant.ownerEmail, tenant.password));
  const expectStatus = <R extends { statusCode: number; body: string }>(
    response: R,
    status: number,
  ): R => {
    if (response.statusCode !== status) {
      throw new Error(`fixture request failed: ${response.statusCode} ${response.body}`);
    }
    return response;
  };

  const locations = expectStatus(await apiRequest(app, 'GET', '/api/v1/locations', owner), 200);
  const locationId = locations.json<{ locations: { id: string }[] }>().locations[0]!.id;
  expectStatus(
    await apiRequest(app, 'PUT', `/api/v1/catalog/locations/${locationId}/operating-hours`, owner, {
      slot_interval_min: 30,
      days: ALL_WEEK,
    }),
    200,
  );
  const createService = async (body: object) =>
    expectStatus(await apiRequest(app, 'POST', '/api/v1/catalog/services', owner, body), 201).json<{
      id: string;
    }>().id;
  const serviceId = await createService({
    name: 'Poli Umum',
    ticket_prefix: 'A',
    avg_duration_min: 10,
  });
  const dpServiceId = await createService({
    name: 'Konsultasi DP',
    ticket_prefix: 'B',
    avg_duration_min: 30,
    requires_dp: true,
    dp_amount: 50000,
  });
  const resource = expectStatus(
    await apiRequest(app, 'POST', '/api/v1/catalog/resources', owner, {
      location_id: locationId,
      name: 'Ruang A',
      service_ids: [serviceId, dpServiceId],
    }),
    201,
  );
  const settings = expectStatus(
    await apiRequest(app, 'GET', '/api/v1/tenants/me/settings', owner),
    200,
  ).json<{ name: string }>();

  return {
    tenantId: tenant.tenantId,
    tenantName: settings.name,
    slug: tenant.slug,
    locationCode: tenant.locationCode,
    locationId,
    serviceId,
    dpServiceId,
    resourceId: resource.json<{ id: string }>().id,
    owner,
  };
}
