// Realtime publishing (spec sections 3.6 and 5.1, S10). The core services write every queue.* and
// booking.reservation.* event, after the commit and next to RabbitMQ, as a compact update without
// personal data to Redis: one Lua call appends it to the location's update log and publishes it on
// the Pub/Sub channel rt:{tenant_id}:{location_id} that the Realtime SSE Gateway subscribes to.
// The same client stores the revocation instant of a location's KIOSK_DISPLAY tokens.
// Redis down never fails a request: the command times out quickly (no offline queue) and
// publishAll logs the failure; the live views catch up on the next update.
import {
  KIOSK_REVOCATION_TTL_SECONDS,
  PUBLISH_UPDATE_SCRIPT,
  REALTIME_LOG_MAXLEN,
  REALTIME_LOG_TTL_MS,
  encodeKioskRevoked,
  kioskRevokedKey,
  realtimeChannel,
  realtimeLogKey,
  toRealtimeUpdate,
} from '@antre/messaging/realtime';
import type { EventEnvelope } from '@antre/event-contracts';
import { createClient } from '@redis/client';

import type { EventPublisher } from '../events/publisher.js';

const CONNECT_TIMEOUT_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 5000;

/** Revocation of all KIOSK_DISPLAY tokens of a location issued before `at`. */
export interface KioskRevocations {
  revokeAll(tenantId: string, locationId: string, at: Date): Promise<void>;
}

export class InMemoryKioskRevocations implements KioskRevocations {
  readonly revocations: { tenantId: string; locationId: string; at: Date }[] = [];

  async revokeAll(tenantId: string, locationId: string, at: Date): Promise<void> {
    this.revocations.push({ tenantId, locationId, at });
  }
}

interface WarnLogger {
  warn(object: object, message: string): void;
}

export class RealtimeUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RealtimeUnavailableError';
  }
}

export class RedisRealtime implements EventPublisher, KioskRevocations {
  private readonly client: ReturnType<typeof createClient>;
  private readonly commandTimeoutMs: number;

  constructor(options: { url: string; commandTimeoutMs?: number; log: WarnLogger }) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 1000;
    this.client = createClient({
      url: options.url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectStrategy: (retries) => Math.min((retries + 1) * 200, MAX_RECONNECT_DELAY_MS),
      },
    });
    this.client.on('error', (error: unknown) => {
      options.log.warn({ err: error }, 'redis realtime error');
    });
  }

  /** Rejects after `timeoutMs` when Redis is unreachable; the client keeps reconnecting. */
  async connect(timeoutMs = CONNECT_TIMEOUT_MS + 1000): Promise<void> {
    await this.withTimeout(
      this.client.connect().then(() => undefined),
      timeoutMs,
    );
  }

  async close(): Promise<void> {
    try {
      await this.withTimeout(this.client.close(), this.commandTimeoutMs * 2);
    } catch {
      this.client.destroy();
    }
  }

  async publish(event: EventEnvelope): Promise<void> {
    const update = toRealtimeUpdate(event);
    if (update === null || event.tenant === null) return;
    await this.command([
      'EVAL',
      PUBLISH_UPDATE_SCRIPT,
      '2',
      realtimeLogKey(event.tenant.id, update.location_id),
      realtimeChannel(event.tenant.id, update.location_id),
      JSON.stringify(update),
      String(REALTIME_LOG_MAXLEN),
      String(REALTIME_LOG_TTL_MS),
    ]);
  }

  async revokeAll(tenantId: string, locationId: string, at: Date): Promise<void> {
    const revokedAt = String(at.getTime());
    await this.command([
      'SET',
      kioskRevokedKey(tenantId, locationId),
      revokedAt,
      'EX',
      String(KIOSK_REVOCATION_TTL_SECONDS),
    ]);
    // Open kiosk streams of the location close at once (the gateway also checks on connect).
    await this.command([
      'PUBLISH',
      realtimeChannel(tenantId, locationId),
      encodeKioskRevoked(at.getTime()),
    ]);
  }

  private async command(args: string[]): Promise<unknown> {
    return this.withTimeout(this.client.sendCommand(args), this.commandTimeoutMs);
  }

  private async withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new RealtimeUnavailableError('Realtime store timed out')),
        timeoutMs,
      );
    });
    pending.catch(() => {});
    try {
      return await Promise.race([pending, timeout]);
    } catch (error) {
      if (error instanceof RealtimeUnavailableError) throw error;
      throw new RealtimeUnavailableError('Realtime store command failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
