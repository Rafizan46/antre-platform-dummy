// Entry point: loads the configuration, connects the antre_app pool, and listens.
import pg from 'pg';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const app = buildApp({
    pool,
    jwtSecret: config.jwtSecret,
    waChannelToken: config.waChannelToken,
    logger: true,
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    app
      .close()
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
    await pool.end();
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed to start');
  process.exitCode = 1;
});
