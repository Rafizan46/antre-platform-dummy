// Event publisher on antre.events with publisher confirms (spec section 7.1, FR-NOTIF-01).
// Fail-safe: `publish` never throws and never waits for a broker that is down. An event that
// cannot be confirmed goes to a bounded in-memory buffer that is flushed, in order, after the
// next (re)connect. The buffer is lost when the process stops while the broker is unreachable;
// that gap (no transactional outbox) is documented in the S08 report and spec section 9.5.
import { EVENT_EXCHANGE, type EventEnvelope } from '@antre/event-contracts';
import type { ConfirmChannel, Options } from 'amqplib';

import { AmqpConnection, type MessagingLogger, type ReconnectOptions } from './connection.js';

export const DEFAULT_CONFIRM_TIMEOUT_MS = 2_000;
export const DEFAULT_MAX_BUFFERED_EVENTS = 1_000;
const FLUSH_RETRY_MS = 1_000;

export class PublishTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`publish not confirmed within ${timeoutMs} ms`);
    this.name = 'PublishTimeoutError';
  }
}

/** Publishes one message and resolves when the broker confirmed it (rejects on nack/timeout). */
export function publishConfirmed(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: Options.Publish,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new PublishTimeoutError(timeoutMs));
    }, timeoutMs);
    try {
      channel.publish(exchange, routingKey, content, options, (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error instanceof Error ? error : new Error('publish nacked by the broker'));
        } else {
          resolve();
        }
      });
    } catch (error) {
      // The channel closed between the readiness check and the publish.
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error('publish failed'));
    }
  });
}

/** AMQP properties of an event message: persistent JSON, message id = event id. */
export function eventMessageOptions(event: EventEnvelope, appId: string): Options.Publish {
  return {
    persistent: true,
    contentType: 'application/json',
    messageId: event.event_id,
    type: event.event_type,
    timestamp: Math.floor(Date.parse(event.timestamp) / 1000),
    appId,
    headers: { schema_version: event.schema_version },
  };
}

export interface RabbitEventPublisherOptions {
  url: string;
  /** Connection name and AMQP app id, e.g. "core-services". */
  name: string;
  log: MessagingLogger;
  confirmTimeoutMs?: number;
  maxBufferedEvents?: number;
  reconnect?: Partial<ReconnectOptions>;
  connectTimeoutMs?: number;
}

export interface PublisherStats {
  published: number;
  buffered: number;
  dropped: number;
}

/** Implements the core-services `EventPublisher` seam on RabbitMQ. */
export class RabbitEventPublisher {
  private readonly options: RabbitEventPublisherOptions;
  private readonly connection: AmqpConnection;
  private readonly buffer: EventEnvelope[] = [];
  private flushing: Promise<void> | null = null;
  private published = 0;
  private dropped = 0;

  constructor(options: RabbitEventPublisherOptions) {
    this.options = options;
    this.connection = new AmqpConnection({
      url: options.url,
      name: options.name,
      log: options.log,
      reconnect: options.reconnect,
      connectTimeoutMs: options.connectTimeoutMs,
      // Flush after the channel is exposed (onChannel runs before that), so do it on the next tick.
      onChannel: async () => {
        setImmediate(() => this.flush());
      },
    });
  }

  get connected(): boolean {
    return this.connection.connected;
  }

  stats(): PublisherStats {
    return { published: this.published, buffered: this.buffer.length, dropped: this.dropped };
  }

  /** Connects in the background; publishing works (buffered) before the broker is reachable. */
  start(): void {
    this.connection.start();
  }

  async waitUntilReady(timeoutMs: number): Promise<boolean> {
    return this.connection.waitUntilReady(timeoutMs);
  }

  async publish(event: EventEnvelope): Promise<void> {
    const channel = this.connection.channel;
    // Keep the order: while older events wait in the buffer, newer ones queue behind them.
    if (channel === null || this.buffer.length > 0 || this.flushing !== null) {
      this.enqueue(event, channel === null ? 'broker unavailable' : 'buffer not empty');
      if (channel !== null) this.flush();
      return;
    }
    try {
      await this.send(channel, event);
    } catch (error) {
      this.options.log.warn(
        { err: error, event_id: event.event_id, event_type: event.event_type },
        'event publish not confirmed; buffered for retry',
      );
      this.enqueue(event, 'publish not confirmed');
      this.flushLater();
    }
  }

  /** Tries to flush the buffer for up to `flushTimeoutMs`, then closes the connection. */
  async close(flushTimeoutMs = 2_000): Promise<void> {
    if (this.buffer.length > 0 && this.connection.channel !== null) {
      this.flush();
      await Promise.race([
        this.flushing ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, flushTimeoutMs).unref()),
      ]);
    }
    await this.flushing?.catch(() => undefined);
    if (this.buffer.length > 0) {
      this.options.log.error(
        {
          count: this.buffer.length,
          event_ids: this.buffer.map((event) => event.event_id),
        },
        'events dropped at shutdown (broker unavailable)',
      );
      this.dropped += this.buffer.length;
      this.buffer.length = 0;
    }
    await this.connection.close();
  }

  private async send(channel: ConfirmChannel, event: EventEnvelope): Promise<void> {
    await publishConfirmed(
      channel,
      EVENT_EXCHANGE,
      event.event_type,
      Buffer.from(JSON.stringify(event)),
      eventMessageOptions(event, this.options.name),
      this.options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
    );
    this.published += 1;
  }

  private enqueue(event: EventEnvelope, reason: string): void {
    const max = this.options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    if (this.buffer.length >= max) {
      const oldest = this.buffer.shift()!;
      this.dropped += 1;
      this.options.log.error(
        { event_id: oldest.event_id, event_type: oldest.event_type, max_buffered: max },
        'event buffer full; oldest event dropped',
      );
    }
    this.buffer.push(event);
    this.options.log.warn(
      {
        event_id: event.event_id,
        event_type: event.event_type,
        buffered: this.buffer.length,
        reason,
      },
      'event buffered',
    );
  }

  /** A lost channel flushes again after the reconnect; a slow broker is retried here. */
  private flushLater(): void {
    setTimeout(() => {
      if (this.connection.channel !== null) this.flush();
    }, FLUSH_RETRY_MS).unref();
  }

  private flush(): void {
    if (this.flushing !== null) return;
    this.flushing = (async () => {
      while (this.buffer.length > 0) {
        const channel = this.connection.channel;
        if (channel === null) return;
        const event = this.buffer[0]!;
        try {
          await this.send(channel, event);
        } catch (error) {
          this.options.log.warn(
            { err: error, event_id: event.event_id },
            'buffered event publish failed; retrying later',
          );
          this.flushLater();
          return;
        }
        // The event may have been dropped meanwhile by a full buffer.
        if (this.buffer[0] === event) this.buffer.shift();
      }
    })().finally(() => {
      this.flushing = null;
    });
  }
}
