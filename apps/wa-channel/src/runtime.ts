// Wiring of the WA Channel Service: Redis store, RabbitMQ publisher (webhook events and
// replies), the wa.inbound consumer, the core services client, the conversation engine, and the
// HTTP app. Used by server.ts and by the integration tests (with test URLs and short backoffs).
import { RabbitEventPublisher, type ReconnectOptions } from '@antre/messaging';

import { buildApp } from './app.js';
import type { WaChannelConfig } from './config.js';
import { ConversationEngine } from './conversation/engine.js';
import { SessionStore } from './conversation/session.js';
import { CoreClient, type CoreApi } from './core-client.js';
import { InboundConsumer } from './inbound/consumer.js';
import { InboundProcessor } from './inbound/processor.js';
import type { Logger } from './logger.js';
import { Metrics } from './metrics.js';
import { RedisStore } from './store.js';

export interface WaChannelRuntime {
  app: ReturnType<typeof buildApp>;
  store: RedisStore;
  publisher: RabbitEventPublisher;
  consumer: InboundConsumer;
  metrics: Metrics;
  /** Connects Redis and RabbitMQ in the background; neither being down is fatal. */
  start(): void;
  /** Graceful stop: HTTP first, then the consumer (in-flight messages), publisher, Redis. */
  stop(): Promise<void>;
}

export interface RuntimeOverrides {
  core?: CoreApi;
  reconnect?: Partial<ReconnectOptions>;
  shutdownTimeoutMs?: number;
}

export function createRuntime(
  config: WaChannelConfig,
  log: Logger,
  overrides: RuntimeOverrides = {},
): WaChannelRuntime {
  const metrics = new Metrics();
  const store = new RedisStore({ url: config.redisUrl, log });
  const publisher = new RabbitEventPublisher({
    url: config.rabbitmqUrl,
    name: 'wa-channel',
    log,
    reconnect: overrides.reconnect,
  });
  const core =
    overrides.core ??
    new CoreClient({
      baseUrl: config.coreServicesUrl,
      serviceToken: config.serviceToken,
      timeoutMs: config.coreTimeoutMs,
    });
  const engine = new ConversationEngine({
    core,
    sessions: new SessionStore(store, config.sessionTtlSeconds),
    log,
  });
  const processor = new InboundProcessor({
    engine,
    store,
    events: publisher,
    log,
    metrics,
    rateLimitPerMinute: config.rateLimitPerMinute,
  });
  const consumer = new InboundConsumer({
    rabbitmqUrl: config.rabbitmqUrl,
    processor,
    prefetch: config.prefetch,
    retryDelaysMs: config.retryDelaysMs,
    log,
    metrics,
    reconnect: overrides.reconnect,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs,
  });
  const app = buildApp({
    metrics,
    readiness: {
      checks: () => ({
        broker: publisher.connected,
        consumer: consumer.ready,
        redis: store.ready,
      }),
    },
    webhook: {
      verifyToken: config.verifyToken,
      appSecret: config.appSecret,
      phoneNumberId: config.phoneNumberId,
      events: publisher,
      store,
      log,
      metrics,
    },
  });

  let stopped: Promise<void> | null = null;
  return {
    app,
    store,
    publisher,
    consumer,
    metrics,
    start() {
      store.connect().catch((error: unknown) => {
        log.warn({ err: error }, 'redis unavailable at start; retrying in the background');
      });
      publisher.start();
      consumer.start();
    },
    stop() {
      stopped ??= (async () => {
        await app.close();
        await consumer.stop();
        await publisher.close();
        await store.close();
      })();
      return stopped;
    },
  };
}
