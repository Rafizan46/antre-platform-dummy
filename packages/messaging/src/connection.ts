// One AMQP connection with one confirm channel, reconnected in the background with exponential
// backoff. Each (re)connect asserts the topology and then runs `onChannel` (consumers, flushes).
// The broker being down never throws out of `start`: callers check `channel` (null = not ready).
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';

import { assertTopology } from './topology.js';

export interface MessagingLogger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface ReconnectOptions {
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface AmqpConnectionOptions {
  /** amqp:// or amqps:// URL; never logged (it carries the password). */
  url: string;
  /** Shown as connection_name in RabbitMQ Management. */
  name: string;
  log: MessagingLogger;
  reconnect?: Partial<ReconnectOptions>;
  /** Socket connect timeout. */
  connectTimeoutMs?: number;
  /** Runs after the topology was asserted on a new channel, before `channel` is exposed. */
  onChannel?: (channel: ConfirmChannel) => Promise<void>;
  /** Runs when a ready channel is lost (connection closed or channel error). */
  onLost?: () => void;
}

const DEFAULT_RECONNECT: ReconnectOptions = { initialDelayMs: 500, maxDelayMs: 30_000 };
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** Delay before reconnect attempt `attempt` (1-based): initial * 2^(attempt-1), capped. */
export function reconnectDelay(attempt: number, options: ReconnectOptions): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** Math.min(exponent, 30));
}

/** Host and port of an AMQP URL, for logs without credentials. */
export function describeBroker(url: string): string {
  try {
    const parsed = new URL(url);
    const vhost = decodeURIComponent(parsed.pathname.slice(1)) || '/';
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === 'amqps:' ? '5671' : '5672')} vhost ${vhost}`;
  } catch {
    return 'invalid url';
  }
}

export class AmqpConnection {
  private readonly options: AmqpConnectionOptions;
  private readonly reconnectOptions: ReconnectOptions;
  private model: ChannelModel | null = null;
  private current: ConfirmChannel | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private started = false;
  private closing = false;
  private connecting: Promise<void> | null = null;
  private readyWaiters: (() => void)[] = [];

  constructor(options: AmqpConnectionOptions) {
    this.options = options;
    this.reconnectOptions = { ...DEFAULT_RECONNECT, ...options.reconnect };
  }

  /** The confirm channel, or null while (re)connecting. */
  get channel(): ConfirmChannel | null {
    return this.current;
  }

  get connected(): boolean {
    return this.current !== null;
  }

  /** Starts connecting in the background. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.connectNow();
  }

  /** Resolves once a channel is ready (or the connection is closed). */
  async waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.current !== null) return true;
    if (this.closing) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter !== done);
        resolve(false);
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve(this.current !== null);
      };
      this.readyWaiters.push(done);
    });
  }

  /** Stops reconnecting and closes the connection. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.connecting;
    const model = this.model;
    const channel = this.current;
    this.model = null;
    this.current = null;
    this.notifyWaiters();
    if (channel !== null) {
      // Close the channel first: its close frame follows any ack still buffered on the channel,
      // whereas a connection close can overtake them (the broker would then requeue the message).
      try {
        await channel.close();
      } catch {
        // Already closed.
      }
    }
    if (model !== null) {
      try {
        await model.close();
      } catch {
        // Already closed by the broker.
      }
    }
  }

  private notifyWaiters(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private connectNow(): void {
    this.timer = null;
    if (this.closing) return;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
  }

  private scheduleReconnect(): void {
    if (this.closing || this.timer !== null || this.connecting !== null) return;
    this.attempt += 1;
    const delay = reconnectDelay(this.attempt, this.reconnectOptions);
    this.timer = setTimeout(() => this.connectNow(), delay);
    this.timer.unref();
  }

  private async open(): Promise<void> {
    const { log, name } = this.options;
    const broker = describeBroker(this.options.url);
    let model: ChannelModel | null = null;
    try {
      model = await connect(this.options.url, {
        timeout: this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        clientProperties: { connection_name: name },
      });
      if (this.closing) {
        await model.close();
        return;
      }
      const opened = model;
      opened.on('error', (error: Error) => {
        log.warn({ err: error, broker }, 'amqp connection error');
      });
      opened.on('close', () => {
        if (this.model === opened) this.lost('connection closed');
      });

      const channel = await opened.createConfirmChannel();
      channel.on('error', (error: Error) => {
        log.warn({ err: error, broker }, 'amqp channel error');
      });
      channel.on('close', () => {
        if (this.current === channel) {
          // A channel error leaves the connection open: drop it and start over.
          this.lost('channel closed');
          opened.close().catch(() => undefined);
        }
      });

      await assertTopology(channel);
      if (this.options.onChannel) await this.options.onChannel(channel);
      if (this.closing) {
        await opened.close();
        return;
      }

      this.model = opened;
      this.current = channel;
      this.attempt = 0;
      log.info({ broker, connection: name }, 'amqp connected');
      this.notifyWaiters();
    } catch (error) {
      log.warn({ err: error, broker, attempt: this.attempt + 1 }, 'amqp connect failed');
      if (model !== null) {
        model.close().catch(() => undefined);
      }
      this.connecting = null;
      this.scheduleReconnect();
    }
  }

  private lost(reason: string): void {
    const wasReady = this.current !== null;
    this.model = null;
    this.current = null;
    if (this.closing) return;
    this.options.log.warn(
      { broker: describeBroker(this.options.url), reason },
      'amqp disconnected',
    );
    if (wasReady) this.options.onLost?.();
    this.scheduleReconnect();
  }
}
