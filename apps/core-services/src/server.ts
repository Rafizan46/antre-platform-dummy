// Entry point: loads the configuration, connects the antre_app pool, Redis, and RabbitMQ, starts
// the booking jobs, and listens.
import { RabbitEventPublisher } from '@antre/messaging';
import pg from 'pg';

import { buildApp } from './app.js';
import { startBookingJobs } from './booking/jobs.js';
import { RedisSlotLock } from './booking/slot-lock.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
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
  const app = buildApp({
    pool,
    jwtSecret: config.jwtSecret,
    waChannelToken: config.waChannelToken,
    slotLock,
    paymentCallbackSecret: config.paymentCallbackSecret,
    events,
    logger: true,
  });

  // Redis down at start is not fatal (D1): the client keeps reconnecting in the background and holds
  // fall back to the unique index meanwhile. The connection is not awaited, so the server still listens.
  slotLock.connect().catch((error: unknown) => {
    app.log.warn({ err: error }, 'redis unavailable at start; holds use the database check');
  });

  // RabbitMQ down at start is not fatal either: events are buffered in memory and flushed after
  // the (re)connect; a publish never fails a request (FR-NOTIF-01, NFR-RELI-01).
  events.start();

  const jobs = startBookingJobs({ pool, slotLock, events, now: () => new Date(), log: app.log });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    jobs
      .stop()
      .then(() => app.close())
      .then(() => events.close())
      .then(() => slotLock.close())
      .then(() => pool.end())
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
    await events.close();
    await slotLock.close();
    await pool.end();
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed to start');
  process.exitCode = 1;
});
