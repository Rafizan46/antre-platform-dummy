// Notification Worker runtime: consumes notifications.wa with manual acks and a prefetch limit,
// hands each event to the processor, and applies the retry policy (delay queues, then DLQ).
// A message is acked only after its outcome is settled: sent, duplicate, or moved (with publisher
// confirms) to a retry queue or the DLQ. Anything that is not a valid event is rejected and
// dead-lettered by the broker. On connection loss unacked messages are redelivered and the
// idempotent processor recognises those already sent.
import { parseEvent, type EventEnvelope } from '@antre/event-contracts';
import {
  AmqpConnection,
  HEADERS,
  NOTIFICATIONS_DLQ,
  NOTIFICATIONS_QUEUE,
  publishConfirmed,
  type ReconnectOptions,
} from '@antre/messaging';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import type pg from 'pg';

import type { Logger } from './logger.js';
import { METRIC_NAMES, Metrics } from './metrics.js';
import { NotificationProcessor } from './processor.js';
import { decideRetry, readRetryCount } from './retry.js';
import type { WhatsAppAdapter } from './whatsapp/adapter.js';

export interface NotificationWorkerOptions {
  pool: pg.Pool;
  rabbitmqUrl: string;
  adapter: WhatsAppAdapter;
  templateLanguage: string;
  /** QRIS simulator link base of the DP message (null = no link). */
  qrisSimulatorUrl?: string | null;
  prefetch: number;
  retryDelaysMs: readonly number[];
  log: Logger;
  metrics?: Metrics;
  reconnect?: Partial<ReconnectOptions>;
  confirmTimeoutMs?: number;
  /** How long `stop` waits for messages in flight. */
  shutdownTimeoutMs?: number;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function safeAck(channel: ConfirmChannel, message: ConsumeMessage): void {
  try {
    channel.ack(message);
  } catch {
    // Channel already closed: the broker redelivers the message, the processor is idempotent.
  }
}

function safeNack(channel: ConfirmChannel, message: ConsumeMessage, requeue: boolean): void {
  try {
    channel.nack(message, false, requeue);
  } catch {
    // Channel already closed: the broker redelivers the message.
  }
}

function forwardOptions(message: ConsumeMessage): Options.Publish {
  const { properties } = message;
  return {
    persistent: true,
    contentType: properties.contentType ?? 'application/json',
    messageId: properties.messageId,
    type: properties.type,
    timestamp: properties.timestamp,
    appId: properties.appId,
  };
}

export class NotificationWorker {
  readonly metrics: Metrics;
  private readonly options: NotificationWorkerOptions;
  private readonly processor: NotificationProcessor;
  private readonly connection: AmqpConnection;
  private readonly inFlight = new Set<Promise<void>>();
  private consumer: { channel: ConfirmChannel; tag: string } | null = null;
  private stopping = false;

  constructor(options: NotificationWorkerOptions) {
    this.options = options;
    this.metrics = options.metrics ?? new Metrics();
    this.processor = new NotificationProcessor({
      pool: options.pool,
      adapter: options.adapter,
      templateLanguage: options.templateLanguage,
      qrisSimulatorUrl: options.qrisSimulatorUrl ?? null,
      log: options.log,
      metrics: this.metrics,
    });
    this.connection = new AmqpConnection({
      url: options.rabbitmqUrl,
      name: 'notification-worker',
      log: options.log,
      reconnect: options.reconnect,
      onChannel: (channel) => this.consume(channel),
      onLost: () => {
        this.consumer = null;
      },
    });
  }

  /** True while the consumer is attached to notifications.wa (readiness). */
  get ready(): boolean {
    return this.consumer !== null && this.connection.connected;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Connects (and reconnects) in the background. */
  start(): void {
    this.connection.start();
  }

  async waitUntilReady(timeoutMs: number): Promise<boolean> {
    return this.connection.waitUntilReady(timeoutMs);
  }

  /** Graceful shutdown: stop consuming, let messages in flight finish, then disconnect. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const consumer = this.consumer;
    this.consumer = null;
    if (consumer !== null) {
      try {
        await consumer.channel.cancel(consumer.tag);
      } catch {
        // Channel already gone.
      }
    }
    if (this.inFlight.size > 0) {
      this.options.log.info({ in_flight: this.inFlight.size }, 'waiting for messages in flight');
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((resolve) => {
          timer = setTimeout(
            resolve,
            this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
          );
        }),
      ]);
      clearTimeout(timer);
    }
    await this.connection.close();
  }

  private async consume(channel: ConfirmChannel): Promise<void> {
    if (this.stopping) return;
    await channel.prefetch(this.options.prefetch);
    const { consumerTag } = await channel.consume(
      NOTIFICATIONS_QUEUE,
      (message) => {
        if (message === null) {
          // Cancelled by the broker (e.g. the queue was deleted): reconnect and declare again.
          this.options.log.warn({}, 'consumer cancelled by the broker');
          this.consumer = null;
          channel.close().catch(() => undefined);
          return;
        }
        const handling = this.handle(channel, message).catch((error: unknown) => {
          this.options.log.error({ err: error }, 'message handling failed');
          safeNack(channel, message, true);
        });
        this.inFlight.add(handling);
        void handling.finally(() => this.inFlight.delete(handling));
      },
      { noAck: false },
    );
    this.consumer = { channel, tag: consumerTag };
  }

  private async handle(channel: ConfirmChannel, message: ConsumeMessage): Promise<void> {
    const log = this.options.log;
    const metrics = this.metrics;
    const headers = (message.properties.headers ?? {}) as Record<string, unknown>;
    const retriesDone = readRetryCount(headers);

    let event: EventEnvelope;
    try {
      event = parseEvent(JSON.parse(message.content.toString('utf8')));
    } catch (error) {
      metrics.increment(METRIC_NAMES.invalid);
      log.error(
        {
          err:
            error instanceof Error
              ? { name: error.name, message: error.message.slice(0, 300) }
              : error,
          message_id: message.properties.messageId ?? null,
          routing_key: message.fields.routingKey,
        },
        'invalid event rejected to the DLQ',
      );
      // Dead-lettered by the broker (x-dead-letter-routing-key = notifications.dlq).
      safeNack(channel, message, false);
      return;
    }

    const outcome = await this.processor.process(event, retriesDone);
    if (outcome.status !== 'failed') {
      safeAck(channel, message);
      return;
    }

    const { failure } = outcome;
    const decision = decideRetry(retriesDone, failure, this.options.retryDelaysMs);
    const routingKey =
      typeof headers[HEADERS.routingKey] === 'string'
        ? (headers[HEADERS.routingKey] as string)
        : message.fields.routingKey;
    const confirmTimeoutMs = this.options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const logFields = {
      event_id: event.event_id,
      event_type: event.event_type,
      failure_kind: failure.kind,
      failure: failure.message,
    };

    try {
      if (decision.action === 'retry') {
        await publishConfirmed(
          channel,
          '',
          decision.queue,
          message.content,
          {
            ...forwardOptions(message),
            expiration: String(decision.delayMs),
            headers: {
              ...headers,
              [HEADERS.retry]: decision.retry,
              [HEADERS.routingKey]: routingKey,
              [HEADERS.error]: failure.message,
              [HEADERS.errorKind]: failure.kind,
            },
          },
          confirmTimeoutMs,
        );
        metrics.increment(METRIC_NAMES.retried, { kind: failure.kind });
        log.warn(
          { ...logFields, retry: decision.retry, delay_ms: decision.delayMs },
          'notification failed; retry scheduled',
        );
      } else {
        await publishConfirmed(
          channel,
          '',
          NOTIFICATIONS_DLQ,
          message.content,
          {
            ...forwardOptions(message),
            headers: {
              ...headers,
              [HEADERS.retry]: retriesDone,
              [HEADERS.routingKey]: routingKey,
              [HEADERS.error]: failure.message,
              [HEADERS.errorKind]: failure.kind,
              [HEADERS.failedAt]: new Date().toISOString(),
            },
          },
          confirmTimeoutMs,
        );
        metrics.increment(METRIC_NAMES.deadLettered, { kind: failure.kind });
        log.error({ ...logFields, retries: retriesDone }, 'notification moved to the DLQ');
        await this.processor.markDeadLettered(event, retriesDone);
      }
      safeAck(channel, message);
    } catch (error) {
      // Could not park the message: give it back to the queue (redelivered, still idempotent).
      log.error({ ...logFields, err: error }, 'could not move failed notification; requeued');
      safeNack(channel, message, true);
    }
  }
}
