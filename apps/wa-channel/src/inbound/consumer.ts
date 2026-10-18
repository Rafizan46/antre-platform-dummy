// Consumer of wa.inbound (spec section 7.1): manual acks with a prefetch limit, retry 3 times with
// exponential backoff through wa.inbound.retry.1-3, then wa.inbound.dlq. A message is acked only
// after its outcome is settled (handled, duplicate, or moved with publisher confirms to a retry
// queue or the DLQ). Anything that is not a valid wa.message.received event is rejected and
// dead-lettered by the broker. After the last retry the customer gets an apology reply.
import { parseEvent, type EventEnvelope } from '@antre/event-contracts';
import {
  AmqpConnection,
  HEADERS,
  MAX_RETRIES,
  WA_INBOUND_DLQ,
  WA_INBOUND_QUEUE,
  WA_INBOUND_RETRY_QUEUES,
  publishConfirmed,
  type ReconnectOptions,
} from '@antre/messaging';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';

import type { Logger } from '../logger.js';
import { METRIC_NAMES, type Metrics } from '../metrics.js';
import type { InboundProcessor } from './processor.js';

export interface InboundConsumerOptions {
  rabbitmqUrl: string;
  processor: InboundProcessor;
  prefetch: number;
  retryDelaysMs: readonly number[];
  log: Logger;
  metrics: Metrics;
  reconnect?: Partial<ReconnectOptions>;
  confirmTimeoutMs?: number;
  /** How long `stop` waits for messages in flight. */
  shutdownTimeoutMs?: number;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export type RetryDecision =
  { action: 'retry'; queue: string; delayMs: number; retry: number } | { action: 'dead-letter' };

/** What to do after a failed attempt when `retriesDone` retries already happened. */
export function decideRetry(retriesDone: number, delaysMs: readonly number[]): RetryDecision {
  if (retriesDone >= MAX_RETRIES) return { action: 'dead-letter' };
  const queue = WA_INBOUND_RETRY_QUEUES[retriesDone]!;
  const delayMs = delaysMs[retriesDone] ?? delaysMs[delaysMs.length - 1] ?? 0;
  return { action: 'retry', queue, delayMs, retry: retriesDone + 1 };
}

/** Retries already done for a delivery (header set by this consumer; absent = first attempt). */
export function readRetryCount(headers: Record<string, unknown> | undefined): number {
  const value = headers?.[HEADERS.retry];
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) return 0;
  return Math.min(number, MAX_RETRIES);
}

/** Short error description without personal data (stored in the DLQ headers). */
export function describeError(error: unknown): { kind: string; message: string } {
  if (error instanceof Error) {
    return { kind: error.name, message: `${error.name}: ${error.message}`.slice(0, 300) };
  }
  return { kind: 'unknown', message: 'unknown error' };
}

function safeAck(channel: ConfirmChannel, message: ConsumeMessage): void {
  try {
    channel.ack(message);
  } catch {
    // Channel already closed: the broker redelivers; the processor is idempotent.
  }
}

function safeNack(channel: ConfirmChannel, message: ConsumeMessage, requeue: boolean): void {
  try {
    channel.nack(message, false, requeue);
  } catch {
    // Channel already closed: the broker redelivers.
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

export class InboundConsumer {
  private readonly options: InboundConsumerOptions;
  private readonly connection: AmqpConnection;
  private readonly inFlight = new Set<Promise<void>>();
  private consumer: { channel: ConfirmChannel; tag: string } | null = null;
  private stopping = false;

  constructor(options: InboundConsumerOptions) {
    this.options = options;
    this.connection = new AmqpConnection({
      url: options.rabbitmqUrl,
      name: 'wa-channel-inbound',
      log: options.log,
      reconnect: options.reconnect,
      onChannel: (channel) => this.consume(channel),
      onLost: () => {
        this.consumer = null;
      },
    });
  }

  /** True while the consumer is attached to wa.inbound (readiness). */
  get ready(): boolean {
    return this.consumer !== null && this.connection.connected;
  }

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
      WA_INBOUND_QUEUE,
      (message) => {
        if (message === null) {
          // Cancelled by the broker (e.g. the queue was deleted): reconnect and declare again.
          this.options.log.warn({}, 'consumer cancelled by the broker');
          this.consumer = null;
          channel.close().catch(() => undefined);
          return;
        }
        const handling = this.handle(channel, message).catch((error: unknown) => {
          this.options.log.error({ err: error }, 'inbound message handling failed');
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
    const { log, metrics, processor } = this.options;
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
        },
        'invalid inbound event rejected to the DLQ',
      );
      safeNack(channel, message, false);
      return;
    }
    if (event.event_type !== 'wa.message.received') {
      metrics.increment(METRIC_NAMES.invalid);
      log.error({ event_type: event.event_type }, 'unexpected event on wa.inbound rejected');
      safeNack(channel, message, false);
      return;
    }

    try {
      await processor.process(event, retriesDone);
      safeAck(channel, message);
      return;
    } catch (error) {
      await this.park(channel, message, event, headers, retriesDone, error);
    }
  }

  /** Moves a failed message to the next retry queue or the DLQ, then acks it. */
  private async park(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    event: EventEnvelope<'wa.message.received'>,
    headers: Record<string, unknown>,
    retriesDone: number,
    error: unknown,
  ): Promise<void> {
    const { log, metrics, processor } = this.options;
    const failure = describeError(error);
    const decision = decideRetry(retriesDone, this.options.retryDelaysMs);
    const confirmTimeoutMs = this.options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const logFields = {
      event_id: event.event_id,
      wamid: event.data.wamid,
      failure: failure.message,
    };
    const failureHeaders = {
      ...headers,
      [HEADERS.routingKey]: 'wa.message.received',
      [HEADERS.error]: failure.message,
      [HEADERS.errorKind]: failure.kind,
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
            headers: { ...failureHeaders, [HEADERS.retry]: decision.retry },
          },
          confirmTimeoutMs,
        );
        metrics.increment(METRIC_NAMES.retried, { kind: failure.kind });
        log.warn(
          { ...logFields, retry: decision.retry, delay_ms: decision.delayMs },
          'inbound message failed; retry scheduled',
        );
      } else {
        await publishConfirmed(
          channel,
          '',
          WA_INBOUND_DLQ,
          message.content,
          {
            ...forwardOptions(message),
            headers: {
              ...failureHeaders,
              [HEADERS.retry]: retriesDone,
              [HEADERS.failedAt]: new Date().toISOString(),
            },
          },
          confirmTimeoutMs,
        );
        metrics.increment(METRIC_NAMES.deadLettered, { kind: failure.kind });
        log.error({ ...logFields, retries: retriesDone }, 'inbound message moved to the DLQ');
        await processor.apologise(event);
      }
      safeAck(channel, message);
    } catch (parkError) {
      // Could not park the message: give it back to the queue (redelivered, still idempotent).
      log.error(
        { ...logFields, err: parkError },
        'could not move failed inbound message; requeued',
      );
      safeNack(channel, message, true);
    }
  }
}
