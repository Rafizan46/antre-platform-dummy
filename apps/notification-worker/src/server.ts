// Entry point: loads the configuration, connects the antre_app pool and RabbitMQ, consumes
// notifications.wa, and serves /healthz, /readyz, and /metrics. SIGINT/SIGTERM stop gracefully.
import pg from 'pg';

import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { createHealthServer } from './http.js';
import { createLogger, type Logger } from './logger.js';
import { Metrics } from './metrics.js';
import type { WhatsAppAdapter } from './whatsapp/adapter.js';
import { MetaCloudAdapter } from './whatsapp/meta.js';
import { SandboxMockAdapter } from './whatsapp/sandbox.js';
import { NotificationWorker } from './worker.js';

function createAdapter(config: WorkerConfig, log: Logger): WhatsAppAdapter {
  if (config.adapter === 'meta' && config.meta !== null) return new MetaCloudAdapter(config.meta);
  if (process.env.NODE_ENV === 'production') {
    log.warn({}, 'WA_ADAPTER=sandbox in production: no WhatsApp message leaves this worker');
  }
  return new SandboxMockAdapter({ log });
}

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const log = createLogger({ level: config.logLevel });
  // One connection per message in flight plus headroom for status updates and DLQ marks.
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.prefetch + 2 });
  pool.on('error', (error) => log.warn({ err: error }, 'idle database connection error'));
  const metrics = new Metrics();
  const worker = new NotificationWorker({
    pool,
    rabbitmqUrl: config.rabbitmqUrl,
    adapter: createAdapter(config, log),
    templateLanguage: config.templateLanguage,
    qrisSimulatorUrl: config.qrisSimulatorUrl,
    prefetch: config.prefetch,
    retryDelaysMs: config.retryDelaysMs,
    log,
    metrics,
  });
  const http = createHealthServer(worker, metrics);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    worker
      .stop()
      .then(() => new Promise<void>((resolve) => http.close(() => resolve())))
      .then(() => pool.end())
      .then(() => log.info({}, 'stopped'))
      .catch((error: unknown) => {
        log.error({ err: error }, 'shutdown failed');
        process.exitCode = 1;
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A broker that is down at start is not fatal: the worker keeps reconnecting in the background.
  worker.start();
  http.on('error', (error) => {
    log.error({ err: error }, 'health server failed to start');
    shutdown('health server error');
    process.exitCode = 1;
  });
  http.listen(config.port, config.host, () => {
    log.info(
      { host: config.host, port: config.port, adapter: config.adapter, prefetch: config.prefetch },
      'notification worker started',
    );
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed to start');
  process.exitCode = 1;
});
