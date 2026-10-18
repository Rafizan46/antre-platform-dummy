// Entry point: loads the configuration, starts Redis and the HTTP server (SSE stream, /healthz,
// /readyz, /metrics). SIGINT/SIGTERM end the open streams and stop gracefully.
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger({ level: config.logLevel });
  const runtime = createRuntime(config, log);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    runtime
      .stop()
      .then(() => log.info({}, 'stopped'))
      .catch((error: unknown) => {
        log.error({ err: error }, 'shutdown failed');
        process.exitCode = 1;
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Redis down at start is not fatal: it reconnects in the background, /readyz answers 503 and
  // new streams 503 meanwhile.
  runtime.start();
  try {
    await runtime.app.listen({ host: config.host, port: config.port });
    log.info({ host: config.host, port: config.port }, 'realtime gateway started');
  } catch (error) {
    log.error({ err: error }, 'failed to start');
    await runtime.stop();
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed to start');
  process.exitCode = 1;
});
