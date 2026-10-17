// Entry point: loads the configuration, connects the antre_app pool and Redis, starts the booking
// jobs, and listens.
import pg from 'pg';

import { buildApp } from './app.js';
import { startBookingJobs } from './booking/jobs.js';
import { RedisSlotLock } from './booking/slot-lock.js';
import { loadConfig } from './config.js';
import { NoopEventPublisher } from './events/publisher.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const events = new NoopEventPublisher();
  // The Redis client logs through the app logger, which exists only after the client does.
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

  const jobs = startBookingJobs({ pool, slotLock, events, now: () => new Date(), log: app.log });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    jobs
      .stop()
      .then(() => app.close())
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
    await slotLock.close();
    await pool.end();
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed to start');
  process.exitCode = 1;
});
