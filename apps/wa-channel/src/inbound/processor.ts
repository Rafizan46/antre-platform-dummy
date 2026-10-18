// Handles one wa.message.received event from wa.inbound: idempotency per wamid, one message of a
// number at a time, the per-number rate limit (FR-WA-08), the conversation, and the reply
// (wa.reply.requested through the Notification Worker, FR-NOTIF-01). Failures are thrown to the
// consumer, which retries and finally dead-letters the message.
//
// Idempotency (a redelivery after a crash, or a duplicate publish): wa:proc:{wamid} is claimed
// with SET NX as "processing" (short TTL) and set to "done" (24 h) after the reply was published.
// A delivery that finds "processing" is retried later (it may still be running elsewhere); one
// that finds "done" is acked without effect. On failure the claim is removed so the retry runs.
import { randomUUID } from 'node:crypto';

import { createEvent, type EventEnvelope } from '@antre/event-contracts';

import type { ConversationEngine, Reply } from '../conversation/engine.js';
import { TEXT, textMessage } from '../conversation/messages.js';
import { maskPhone, type Logger } from '../logger.js';
import { METRIC_NAMES, type Metrics } from '../metrics.js';
import { KEYS, type KeyValueStore } from '../store.js';
import type { EventSink } from '../webhook/routes.js';

// Shorter than the second retry delay (25 s): a claim or lock left behind by a command that
// timed out on the client but still ran in Redis (e.g. Redis stalled) cannot block every retry.
// A turn makes at most ~4 sequential core calls (5 s timeout each), so it fits in 20 s.
const PROCESSING_TTL_MS = 20_000;
const DEFAULT_LOCK_TTL_MS = 20_000;
const DONE_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
/** Free-form replies are allowed only within 24 hours of the customer's message (FR-WA-07). */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Another delivery of the same message or number is being handled: retry later. */
export class BusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusyError';
  }
}

export interface ProcessorOptions {
  engine: ConversationEngine;
  store: KeyValueStore;
  events: EventSink;
  log: Logger;
  metrics: Metrics;
  rateLimitPerMinute: number;
  /** Lifetime of the per-number lock; must exceed the slowest conversation turn. */
  lockTtlMs?: number;
  /** How long a message waits for the lock of its number before it is retried. */
  lockWaitMs?: number;
  now?: () => Date;
}

export type InboundOutcome = 'replied' | 'silent' | 'duplicate' | 'rate-limited' | 'expired';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class InboundProcessor {
  private readonly options: ProcessorOptions;
  private readonly now: () => Date;

  constructor(options: ProcessorOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  /** `retriesDone` = retries before this attempt (0 on the first delivery). */
  async process(
    event: EventEnvelope<'wa.message.received'>,
    retriesDone: number,
  ): Promise<InboundOutcome> {
    const { store, log, metrics } = this.options;
    const { wamid, from } = event.data;
    const processedKey = KEYS.processed(wamid);

    if (!(await store.setIfAbsent(processedKey, 'processing', PROCESSING_TTL_MS))) {
      if ((await store.get(processedKey)) === 'done') {
        metrics.increment(METRIC_NAMES.inboundDuplicates, { stage: 'consumer' });
        log.info({ wamid }, 'inbound message already handled; duplicate ignored');
        return 'duplicate';
      }
      throw new BusyError('message is being handled by another delivery');
    }

    try {
      const outcome = await this.withPhoneLock(from, () => this.converse(event, retriesDone));
      await store.set(processedKey, 'done', DONE_TTL_MS);
      metrics.increment(METRIC_NAMES.conversations, { outcome });
      return outcome;
    } catch (error) {
      await store.delete(processedKey).catch(() => undefined);
      throw error;
    }
  }

  /** Replies with an apology after the message was dead-lettered. Best effort. */
  async apologise(event: EventEnvelope<'wa.message.received'>): Promise<void> {
    if (!this.withinWindow(event)) return;
    try {
      await this.publish(event, {
        tenant: null,
        location: null,
        message: textMessage(TEXT.serviceTrouble),
      });
    } catch (error) {
      this.options.log.warn({ err: error, wamid: event.data.wamid }, 'apology not published');
    }
  }

  private withinWindow(event: EventEnvelope): boolean {
    return this.now().getTime() - Date.parse(event.timestamp) < REPLY_WINDOW_MS;
  }

  private async converse(
    event: EventEnvelope<'wa.message.received'>,
    retriesDone: number,
  ): Promise<InboundOutcome> {
    const { engine, store, log, metrics, rateLimitPerMinute } = this.options;
    const { data } = event;

    if (!this.withinWindow(event)) {
      log.warn({ wamid: data.wamid }, 'inbound message older than 24 hours; no reply');
      return 'expired';
    }

    // Counted on the first delivery only, so retries do not use up the customer's budget.
    if (retriesDone === 0) {
      const count = await store.increment(KEYS.rateLimit(data.from), RATE_WINDOW_MS);
      if (count > rateLimitPerMinute) {
        metrics.increment(METRIC_NAMES.rateLimited);
        log.warn({ from: maskPhone(data.from), count }, 'inbound rate limit exceeded');
        // One warning per window; further messages are ignored (FR-WA-08).
        if (count === rateLimitPerMinute + 1) {
          await this.publish(event, {
            tenant: null,
            location: null,
            message: textMessage(TEXT.rateLimited),
          });
        }
        return 'rate-limited';
      }
    }

    const reply = await engine.handle({
      from: data.from,
      profileName: data.profile_name,
      type: data.type,
      text: data.text,
      replyId: data.reply_id,
    });
    if (reply === null) return 'silent';
    await this.publish(event, reply);
    return 'replied';
  }

  private async publish(event: EventEnvelope<'wa.message.received'>, reply: Reply): Promise<void> {
    const outbound = createEvent('wa.reply.requested', {
      tenant: reply.tenant,
      location: reply.tenant === null ? null : reply.location,
      data: { to: event.data.from, message: reply.message },
    });
    await this.options.events.publish(outbound);
    this.options.metrics.increment(METRIC_NAMES.repliesRequested, {
      tenanted: String(reply.tenant !== null),
      kind: reply.message.kind,
    });
    this.options.log.info(
      {
        event_id: outbound.event_id,
        in_reply_to: event.data.wamid,
        to: maskPhone(event.data.from),
        kind: reply.message.kind,
        tenant_id: reply.tenant?.id ?? null,
      },
      'reply requested',
    );
  }

  /** Runs `work` while holding wa:lock:{phone} (compare-and-delete release). */
  private async withPhoneLock<T>(phone: string, work: () => Promise<T>): Promise<T> {
    const { store } = this.options;
    const key = KEYS.phoneLock(phone);
    const token = randomUUID();
    const ttl = this.options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    const deadline = Date.now() + (this.options.lockWaitMs ?? 5_000);
    while (!(await store.setIfAbsent(key, token, ttl))) {
      if (Date.now() >= deadline) throw new BusyError('another message of this number is running');
      await sleep(50);
    }
    try {
      return await work();
    } finally {
      await store.deleteIfEquals(key, token).catch(() => undefined);
    }
  }
}
