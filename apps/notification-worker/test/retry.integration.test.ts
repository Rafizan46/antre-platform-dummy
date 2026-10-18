// FR-NOTIF-05: transient failures are retried 3 times with exponential backoff through the
// delay queues, then the message is parked in notifications.dlq for audit.
import {
  HEADERS,
  NOTIFICATIONS_DLQ,
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_RETRY_QUEUES,
} from '@antre/messaging';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { METRIC_NAMES } from '../src/metrics.js';
import { ticketCreated } from './fixtures.js';
import {
  TEST_RETRY_DELAYS_MS,
  createHarness,
  createTenant,
  drain,
  logsOf,
  messageCount,
  purgeQueues,
  waitFor,
  type Harness,
  type TestTenant,
} from './helpers.js';

let h: Harness;
let scope: TestTenant;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await purgeQueues(h.inspect);
  h.adapter.reset();
  scope = await createTenant(h.pool);
});

async function logOf(eventId: string) {
  return (await logsOf(h.pool, scope.tenant.id)).find((row) => row.event_id === eventId);
}

async function dlqMessages() {
  await waitFor(async () =>
    (await messageCount(h.inspect, NOTIFICATIONS_DLQ)) > 0 ? true : undefined,
  );
  return drain(h.inspect, NOTIFICATIONS_DLQ);
}

describe('retry and DLQ', () => {
  it('retries a transient failure with backoff, then sends (retry_count = retries)', async () => {
    h.adapter.failNext('unavailable', 'rate_limited');
    const event = ticketCreated({}, scope);
    const started = Date.now();
    await h.publish(event);

    const log = await waitFor(async () => {
      const row = await logOf(event.event_id);
      return row?.delivery_status === 'SENT' ? row : undefined;
    });
    const elapsed = Date.now() - started;
    expect(log.retry_count).toBe(2);
    expect(h.adapter.attempts).toBe(3);
    expect(h.adapter.sent).toHaveLength(1);
    // Waited at least the first two backoff delays.
    expect(elapsed).toBeGreaterThanOrEqual(TEST_RETRY_DELAYS_MS[0]! + TEST_RETRY_DELAYS_MS[1]!);
    expect(h.metrics.total(METRIC_NAMES.retried)).toBeGreaterThanOrEqual(2);
    expect(await messageCount(h.inspect, NOTIFICATIONS_DLQ)).toBe(0);
  });

  it('moves a message that keeps failing to the DLQ after 3 retries', async () => {
    h.adapter.failAlways('unavailable');
    const event = ticketCreated({}, scope);
    await h.publish(event);

    const [dead, ...rest] = await dlqMessages();
    expect(rest).toHaveLength(0);
    expect(h.adapter.attempts).toBe(4);
    expect(h.adapter.sent).toHaveLength(0);
    expect(JSON.parse(dead!.content.toString('utf8')).event_id).toBe(event.event_id);
    expect(dead!.properties.messageId).toBe(event.event_id);
    expect(dead!.properties.headers).toMatchObject({
      [HEADERS.retry]: 3,
      [HEADERS.routingKey]: 'queue.ticket.created',
      [HEADERS.errorKind]: 'unavailable',
    });
    expect(typeof dead!.properties.headers?.[HEADERS.failedAt]).toBe('string');

    const log = await waitFor(async () => {
      const row = await logOf(event.event_id);
      return row?.delivery_status === 'DLQ' ? row : undefined;
    });
    expect(log).toMatchObject({ retry_count: 3, provider_message_id: null });
    for (const queue of [NOTIFICATIONS_QUEUE, ...NOTIFICATIONS_RETRY_QUEUES]) {
      expect(await messageCount(h.inspect, queue)).toBe(0);
    }
  });

  it('moves a permanently rejected message to the DLQ without retrying', async () => {
    h.adapter.failAlways('rejected');
    const event = ticketCreated({}, scope);
    await h.publish(event);

    const [dead] = await dlqMessages();
    expect(dead!.properties.headers).toMatchObject({
      [HEADERS.retry]: 0,
      [HEADERS.errorKind]: 'rejected',
    });
    expect(h.adapter.attempts).toBe(1);
    await waitFor(async () =>
      (await logOf(event.event_id))?.delivery_status === 'DLQ' ? true : undefined,
    );
  });

  it('rejects a message that is not a valid event straight to the DLQ (broker dead-letter)', async () => {
    h.inspect.publish('', NOTIFICATIONS_QUEUE, Buffer.from('not json'), { persistent: true });
    h.inspect.publish(
      '',
      NOTIFICATIONS_QUEUE,
      Buffer.from(JSON.stringify({ event_id: 'evt-12345678', event_type: 'queue.ticket.created' })),
      { persistent: true },
    );
    await waitFor(async () =>
      (await messageCount(h.inspect, NOTIFICATIONS_DLQ)) === 2 ? true : undefined,
    );
    const dead = await drain(h.inspect, NOTIFICATIONS_DLQ);
    expect(dead.map((message) => message.properties.headers?.['x-death']?.[0]?.reason)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(h.metrics.total(METRIC_NAMES.invalid)).toBeGreaterThanOrEqual(2);
    expect(h.adapter.attempts).toBe(0);
  });

  it('a failing delivery does not hold back other messages', async () => {
    h.adapter.failNext('unavailable');
    const first = ticketCreated({}, scope);
    const second = ticketCreated({ ticket_number: 'A-013' }, scope);
    await h.publish(first);
    await h.publish(second);
    const sentSecond = await waitFor(async () => {
      const row = await logOf(second.event_id);
      return row?.delivery_status === 'SENT' ? row : undefined;
    });
    expect(sentSecond.retry_count).toBe(0);
    await waitFor(async () =>
      (await logOf(first.event_id))?.delivery_status === 'SENT' ? true : undefined,
    );
    expect((await logOf(first.event_id))?.retry_count).toBe(1);
  });
});
