import { createEvent, type EventEnvelope } from '@antre/event-contracts';
import { HEADERS, WA_INBOUND_RETRY_QUEUES } from '@antre/messaging';
import { beforeEach, describe, expect, it } from 'vitest';

import { ConversationEngine } from '../conversation/engine.js';
import { SessionStore } from '../conversation/session.js';
import { CoreUnavailableError } from '../core-client.js';
import { silentLogger } from '../logger.js';
import { METRIC_NAMES, Metrics } from '../metrics.js';
import { InMemoryStore, KEYS } from '../store.js';
import { FakeCore, PHONE, RecordingSink, TENANT_ID } from '../testing.js';
import { decideRetry, describeError, readRetryCount } from './consumer.js';
import { BusyError, InboundProcessor } from './processor.js';

const NOW = new Date('2026-10-19T03:00:00Z');

let core: FakeCore;
let store: InMemoryStore;
let sink: RecordingSink;
let metrics: Metrics;
let processor: InboundProcessor;
let clock: Date;

function inbound(
  text: string | null,
  options: { wamid?: string; at?: Date; from?: string } = {},
): EventEnvelope<'wa.message.received'> {
  return createEvent(
    'wa.message.received',
    {
      tenant: null,
      location: null,
      data: {
        wamid: options.wamid ?? `wamid.${Math.random().toString(36).slice(2)}`,
        from: options.from ?? PHONE,
        profile_name: 'Budi',
        type: 'text',
        text,
        reply_id: null,
      },
    },
    { now: options.at ?? clock },
  );
}

beforeEach(() => {
  clock = NOW;
  core = new FakeCore();
  store = new InMemoryStore({ now: () => clock.getTime() });
  sink = new RecordingSink();
  metrics = new Metrics();
  const engine = new ConversationEngine({
    core,
    sessions: new SessionStore(store, 1800),
    log: silentLogger,
    now: () => clock,
  });
  processor = new InboundProcessor({
    engine,
    store,
    events: sink,
    log: silentLogger,
    metrics,
    rateLimitPerMinute: 3,
    lockWaitMs: 100,
    now: () => clock,
  });
});

describe('InboundProcessor', () => {
  it('publishes the reply as wa.reply.requested to the sender, with the tenant of the session', async () => {
    expect(await processor.process(inbound('ANTRE klinik-sehat pusat'), 0)).toBe('replied');
    const [reply] = sink.ofType('wa.reply.requested');
    expect(reply?.tenant?.id).toBe(TENANT_ID);
    expect(reply?.location?.code).toBe('pusat');
    expect(reply?.data.to).toBe(PHONE);
    expect(reply?.data.message.kind).toBe('buttons');

    expect(await processor.process(inbound('halo', { from: '6289999999999' }), 0)).toBe('replied');
    expect(sink.ofType('wa.reply.requested')[1]?.tenant).toBeNull();
  });

  it('handles a wamid once: a redelivery after success is a duplicate', async () => {
    const event = inbound('ANTRE klinik-sehat pusat', { wamid: 'wamid.ONE' });
    await processor.process(event, 0);
    expect(await processor.process(event, 0)).toBe('duplicate');
    expect(sink.events).toHaveLength(1);
    expect(store.ttl(KEYS.processed('wamid.ONE'))).toBe(24 * 60 * 60 * 1000);
    expect(metrics.total(METRIC_NAMES.inboundDuplicates, { stage: 'consumer' })).toBe(1);
  });

  it('a delivery that finds the message still processing is retried later', async () => {
    await store.setIfAbsent(KEYS.processed('wamid.BUSY'), 'processing', 60_000);
    await expect(
      processor.process(inbound('halo', { wamid: 'wamid.BUSY' }), 0),
    ).rejects.toBeInstanceOf(BusyError);
  });

  it('waits for the lock of the number and gives up with BusyError', async () => {
    await store.setIfAbsent(KEYS.phoneLock(PHONE), 'other', 60_000);
    await expect(
      processor.process(inbound('halo', { wamid: 'wamid.LOCK' }), 0),
    ).rejects.toBeInstanceOf(BusyError);
    // The claim was released, so the retry can run.
    expect(await store.get(KEYS.processed('wamid.LOCK'))).toBeNull();
  });

  it('releases the claim when the core services are unavailable, so the retry runs again', async () => {
    await processor.process(inbound('ANTRE klinik-sehat pusat'), 0);
    core.failNext('listServices', new CoreUnavailableError('down'));
    const event = inbound('1', { wamid: 'wamid.RETRY' });
    await expect(processor.process(event, 0)).rejects.toBeInstanceOf(CoreUnavailableError);
    expect(await store.get(KEYS.processed('wamid.RETRY'))).toBeNull();
    expect(await processor.process(event, 1)).toBe('replied');
    expect(await store.get(KEYS.phoneLock(PHONE))).toBeNull();
  });

  it('rate limits per number: one warning, then silence (FR-WA-08)', async () => {
    for (let index = 0; index < 3; index += 1) {
      expect(await processor.process(inbound('halo'), 0)).toBe('replied');
    }
    expect(await processor.process(inbound('halo'), 0)).toBe('rate-limited');
    expect(await processor.process(inbound('halo'), 0)).toBe('rate-limited');
    const replies = sink.ofType('wa.reply.requested');
    expect(replies).toHaveLength(4);
    expect(replies[3]?.data.message.body).toContain('terlalu banyak pesan');
    expect(metrics.total(METRIC_NAMES.rateLimited)).toBe(2);

    // Retries are not counted, and the window ends after a minute.
    expect(await processor.process(inbound('halo'), 1)).toBe('replied');
    clock = new Date(NOW.getTime() + 61_000);
    expect(await processor.process(inbound('halo'), 0)).toBe('replied');
  });

  it('does not reply to a message older than 24 hours (FR-WA-07)', async () => {
    const old = inbound('halo', { at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) });
    expect(await processor.process(old, 0)).toBe('expired');
    expect(sink.events).toHaveLength(0);
  });

  it('apologises without tenant after the message was dead-lettered', async () => {
    await processor.apologise(inbound('halo'));
    const [reply] = sink.ofType('wa.reply.requested');
    expect(reply?.tenant).toBeNull();
    expect(reply?.data.message.body).toContain('sedang mengalami gangguan');
  });
});

describe('retry policy of wa.inbound', () => {
  it('retries 3 times through the delay queues, then dead-letters', () => {
    const delays = [5000, 25000, 125000];
    expect(decideRetry(0, delays)).toEqual({
      action: 'retry',
      queue: WA_INBOUND_RETRY_QUEUES[0],
      delayMs: 5000,
      retry: 1,
    });
    expect(decideRetry(2, delays)).toMatchObject({ queue: 'wa.inbound.retry.3', delayMs: 125000 });
    expect(decideRetry(3, delays)).toEqual({ action: 'dead-letter' });
  });

  it('reads the retry header defensively', () => {
    expect(readRetryCount(undefined)).toBe(0);
    expect(readRetryCount({ [HEADERS.retry]: 2 })).toBe(2);
    expect(readRetryCount({ [HEADERS.retry]: '1' })).toBe(1);
    expect(readRetryCount({ [HEADERS.retry]: -1 })).toBe(0);
    expect(readRetryCount({ [HEADERS.retry]: 99 })).toBe(3);
  });

  it('describes errors briefly for the DLQ headers', () => {
    expect(describeError(new CoreUnavailableError('core services timed out: GET /x'))).toEqual({
      kind: 'CoreUnavailableError',
      message: 'CoreUnavailableError: core services timed out: GET /x',
    });
    expect(describeError('boom')).toEqual({ kind: 'unknown', message: 'unknown error' });
  });
});
