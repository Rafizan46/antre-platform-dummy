// Fan-out of the Redis Pub/Sub channels to the SSE streams. One subscription per channel
// (rt:{tenant}:{location}) however many streams watch it; it is dropped with the last stream.
// Also enforces the connection limits (global and per tenant) and closes kiosk streams when the
// kiosk tokens of their location are revoked.
import { decodeRealtimeMessage, realtimeChannel } from '@antre/messaging/realtime';

import type { Logger } from './logger.js';
import { METRIC_NAMES, type Metrics } from './metrics.js';
import type { RealtimeStore } from './store.js';
import type { CloseReason, SseStream } from './stream.js';

interface ChannelEntry {
  streams: Set<SseStream>;
  subscribed: Promise<void>;
}

export type Admission = 'ok' | 'tenant_limit' | 'global_limit';

const UNSUBSCRIBE_TIMEOUT_MS = 2000;

async function withTimeout(pending: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('unsubscribe timed out')), timeoutMs);
  });
  pending.catch(() => undefined);
  try {
    await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class Broadcaster {
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly perTenant = new Map<string, number>();
  /** UNSUBSCRIBE in flight per channel. */
  private readonly unsubscribing = new Map<string, Promise<void>>();
  private total = 0;

  constructor(
    private readonly options: {
      store: RealtimeStore;
      metrics: Metrics;
      log: Logger;
      maxConnections: number;
      maxConnectionsPerTenant: number;
    },
  ) {}

  get connections(): number {
    return this.total;
  }

  admission(tenantId: string): Admission {
    if (this.total >= this.options.maxConnections) return 'global_limit';
    if ((this.perTenant.get(tenantId) ?? 0) >= this.options.maxConnectionsPerTenant) {
      return 'tenant_limit';
    }
    return 'ok';
  }

  /**
   * Registers the stream (it counts against the limits at once) and resolves when its channel is
   * subscribed. Rejects when the subscription fails; the stream is then unregistered.
   */
  async add(stream: SseStream): Promise<void> {
    const { tenantId, locationId } = stream.identity;
    const channel = realtimeChannel(tenantId, locationId);
    this.total += 1;
    this.perTenant.set(tenantId, (this.perTenant.get(tenantId) ?? 0) + 1);

    let entry = this.channels.get(channel);
    if (entry === undefined) {
      const created: ChannelEntry = {
        streams: new Set(),
        subscribed: (this.unsubscribing.get(channel) ?? Promise.resolve()).then(() =>
          this.options.store.subscribe(channel, (message) => this.dispatch(channel, message)),
        ),
      };
      // Observed here so a failed subscription never becomes an unhandled rejection.
      created.subscribed.catch(() => undefined);
      this.channels.set(channel, created);
      entry = created;
    }
    entry.streams.add(stream);
    stream.onClose((reason) => this.remove(stream, channel, reason));
    await entry.subscribed;
  }

  closeAll(reason: CloseReason): void {
    for (const entry of [...this.channels.values()]) {
      for (const stream of [...entry.streams]) stream.close(reason);
    }
  }

  heartbeat(): void {
    for (const entry of this.channels.values()) {
      for (const stream of entry.streams) stream.heartbeat();
    }
  }

  private remove(stream: SseStream, channel: string, reason: CloseReason): void {
    const entry = this.channels.get(channel);
    if (entry === undefined || !entry.streams.delete(stream)) return;
    const { tenantId } = stream.identity;
    this.total -= 1;
    const remaining = (this.perTenant.get(tenantId) ?? 1) - 1;
    if (remaining <= 0) this.perTenant.delete(tenantId);
    else this.perTenant.set(tenantId, remaining);
    this.options.metrics.increment(METRIC_NAMES.clientsClosed, { reason });

    if (entry.streams.size === 0) {
      this.channels.delete(channel);
      // Not awaited: during an outage the UNSUBSCRIBE waits for the reconnect. A new stream of the
      // same channel subscribes only after it, because UNSUBSCRIBE drops every listener of the
      // channel, including one added in between.
      const unsubscribed: Promise<void> = entry.subscribed
        .then(() => withTimeout(this.options.store.unsubscribe(channel), UNSUBSCRIBE_TIMEOUT_MS))
        .catch((error: unknown) => {
          this.options.log.debug({ err: error }, 'unsubscribe failed');
        })
        .finally(() => {
          if (this.unsubscribing.get(channel) === unsubscribed) this.unsubscribing.delete(channel);
        });
      this.unsubscribing.set(channel, unsubscribed);
    }
  }

  private dispatch(channel: string, raw: string): void {
    const message = decodeRealtimeMessage(raw);
    if (message === null) {
      this.options.metrics.increment(METRIC_NAMES.updatesReceived, { kind: 'invalid' });
      return;
    }
    this.options.metrics.increment(METRIC_NAMES.updatesReceived, { kind: message.kind });
    const streams = this.channels.get(channel)?.streams;
    if (streams === undefined) return;
    for (const stream of [...streams]) {
      if (message.kind === 'update') {
        stream.deliver(message.id, message.update);
      } else if (
        stream.identity.kind === 'kiosk' &&
        (stream.identity.kioskIssuedAtMs ?? 0) <= message.revokedAt
      ) {
        stream.close('kiosk_revoked');
      }
    }
  }
}
