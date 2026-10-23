// Entry point: loads the configuration, connects the antre_app pool, Redis, and RabbitMQ, starts
// the booking and subscription jobs, and listens. The antre_platform_admin pool (Super Admin
// console, S11) is optional.
import { RabbitEventPublisher } from '@antre/messaging';
import pg from 'pg';

import { buildApp } from './app.js';
import { startBillingJobs } from './billing/jobs.js';
import { startBookingJobs } from './booking/jobs.js';
import { RedisSlotLock } from './booking/slot-lock.js';
import { loadConfig } from './config.js';
import { handlePoolErrors } from './db/pool-errors.js';
import { FanoutEventPublisher } from './events/publisher.js';
import { RedisRealtime } from './realtime/redis-realtime.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const platformAdminPool =
    config.platformAdminDatabaseUrl === null
      ? null
      : new pg.Pool({ connectionString: config.platformAdminDatabaseUrl, max: 2 });
  handlePoolErrors(pool, 'app', () => app.log);
  if (platformAdminPool !== null)
    handlePoolErrors(platformAdminPool, 'platform_admin', () => app.log);
  // The Redis client and the publisher log through the app logger, which exists only after them.
  const events = new RabbitEventPublisher({
    url: config.rabbitmqUrl,
    name: 'core-services',
    log: {
      info: (object, message) => app.log.info(object, message),
      warn: (object, message) => app.log.warn(object, message),
      error: (object, message) => app.log.error(object, message),
    },
  });
  const slotLock = new RedisSlotLock({
    url: config.redisUrl,
    log: { warn: (object, message) => app.log.warn(object, message) },
  });
  // S10: every event also goes to Redis (update log + Pub/Sub) for the Realtime SSE Gateway.
  const realtime = new RedisRealtime({
    url: config.redisUrl,
    log: { warn: (object, message) => app.log.warn(object, message) },
  });
  const publisher = new FanoutEventPublisher([events, realtime]);
  const app = buildApp({
    pool,
    jwtSecret: config.jwtSecret,
    waChannelToken: config.waChannelToken,
    slotLock,
    paymentCallbackSecret: config.paymentCallbackSecret,
    events: publisher,
    kioskRevocations: realtime,
    platformAdminPool: platformAdminPool ?? undefined,
    logger: true,
  });

  // Redis down at start is not fatal (D1): the client keeps reconnecting in the background and holds
  // fall back to the unique index meanwhile. The connection is not awaited, so the server still listens.
  slotLock.connect().catch((error: unknown) => {
    app.log.warn({ err: error }, 'redis unavailable at start; holds use the database check');
  });

  realtime.connect().catch((error: unknown) => {
    app.log.warn({ err: error }, 'redis unavailable at start; realtime updates are skipped');
  });

  // RabbitMQ down at start is not fatal either: events are buffered in memory and flushed after
  // the (re)connect; a publish never fails a request (FR-NOTIF-01, NFR-RELI-01).
  events.start();

  const jobs = startBookingJobs({
    pool,
    slotLock,
    events: publisher,
    now: () => new Date(),
    log: app.log,
  });
  // S11: expired subscription checkouts and ended PAID_LOCATION periods (spec section 6.3).
  const billingJobs = startBillingJobs({ pool, now: () => new Date(), log: app.log });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    Promise.all([jobs.stop(), billingJobs.stop()])
      .then(() => app.close())
      .then(() => events.close())
      .then(() => slotLock.close())
      .then(() => realtime.close())
      .then(() => pool.end())
      .then(() => platformAdminPool?.end())
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exitCode = 1;
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    await jobs.stop();
    await billingJobs.stop();
    await events.close();
    await slotLock.close();
    await realtime.close();
    await pool.end();
    await platformAdminPool?.end();
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed to start');
  process.exitCode = 1;
});
