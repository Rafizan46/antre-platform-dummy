// Wires the gateway: Redis store, broadcaster, HTTP app, heartbeat timer, and the reaction to a
// Redis outage (all streams close; clients reconnect and get 503 until Redis is back).
import { buildApp } from './app.js';
import { createTokenVerifier } from './auth.js';
import { Broadcaster } from './broadcaster.js';
import type { RealtimeConfig } from './config.js';
import type { Logger } from './logger.js';
import { METRIC_NAMES, Metrics } from './metrics.js';
import { RedisRealtimeStore } from './store.js';

export interface RealtimeRuntime {
  app: ReturnType<typeof buildApp>;
  store: RedisRealtimeStore;
  broadcaster: Broadcaster;
  metrics: Metrics;
  start(): void;
  stop(): Promise<void>;
}

export function createRuntime(
  config: RealtimeConfig,
  log: Logger,
  options: { now?: () => Date } = {},
): RealtimeRuntime {
  const now = options.now ?? (() => new Date());
  const metrics = new Metrics();
  const store = new RedisRealtimeStore({ url: config.redisUrl, log });
  const broadcaster = new Broadcaster({
    store,
    metrics,
    log,
    maxConnections: config.maxConnections,
    maxConnectionsPerTenant: config.maxConnectionsPerTenant,
  });
  metrics.gauge(METRIC_NAMES.connections, () => broadcaster.connections);
  metrics.gauge(METRIC_NAMES.redisReady, () => (store.ready ? 1 : 0));
  store.onAvailability((ready) => {
    if (ready) {
      log.info({}, 'redis ready');
      return;
    }
    log.warn({ connections: broadcaster.connections }, 'redis unavailable; closing streams');
    broadcaster.closeAll('redis_unavailable');
  });

  const app = buildApp({
    config,
    store,
    broadcaster,
    tokens: createTokenVerifier({ secret: config.jwtSecret, now }),
    metrics,
    log,
    now,
  });

  let heartbeat: NodeJS.Timeout | undefined;
  return {
    app,
    store,
    broadcaster,
    metrics,
    start() {
      store.start(log);
      heartbeat = setInterval(() => broadcaster.heartbeat(), config.heartbeatMs);
      heartbeat.unref();
    },
    async stop() {
      clearInterval(heartbeat);
      await app.close();
      await store.close();
    },
  };
}
