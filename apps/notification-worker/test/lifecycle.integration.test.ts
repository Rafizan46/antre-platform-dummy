// Fail-safe publishing (broker unreachable, then back) and graceful shutdown of the worker.
import { NOTIFICATIONS_QUEUE, RabbitEventPublisher } from '@antre/messaging';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { silentLogger } from '../src/logger.js';
import { LATE_VHOST, createVhost, deleteVhost, vhostUrl } from './broker.js';
import { ticketCreated } from './fixtures.js';
import {
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
  h = await createHarness({ startWorker: false });
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await purgeQueues(h.inspect);
  h.adapter.reset();
  scope = await createTenant(h.pool);
});

describe('publisher', () => {
  it('buffers events while the broker refuses the connection and flushes them once it is back', async () => {
    await deleteVhost(LATE_VHOST);
    const publisher = new RabbitEventPublisher({
      url: vhostUrl(LATE_VHOST),
      name: 'test-late-publisher',
      log: silentLogger,
      reconnect: { initialDelayMs: 100, maxDelayMs: 200 },
    });
    publisher.start();
    try {
      const events = [ticketCreated({}, scope), ticketCreated({ ticket_number: 'A-013' }, scope)];
      const started = Date.now();
      for (const event of events) await publisher.publish(event);
      // publish() returns at once: a request never waits for (or fails on) the broker.
      expect(Date.now() - started).toBeLessThan(500);
      expect(publisher.connected).toBe(false);
      expect(publisher.stats()).toMatchObject({ published: 0, buffered: 2 });

      await createVhost(LATE_VHOST);
      await waitFor(() => (publisher.stats().published === 2 ? true : undefined), 10_000, 'flush');
      expect(publisher.stats()).toMatchObject({ buffered: 0, dropped: 0 });

      const { connect } = await import('amqplib');
      const model = await connect(vhostUrl(LATE_VHOST));
      try {
        const channel = await model.createChannel();
        const delivered = await drain(channel, NOTIFICATIONS_QUEUE);
        // In order, persistent, routed by event_type into notifications.wa (topology asserted on connect).
        expect(
          delivered.map((message) => JSON.parse(message.content.toString('utf8')).event_id),
        ).toEqual(events.map((event) => event.event_id));
        expect(delivered.every((message) => message.properties.deliveryMode === 2)).toBe(true);
        expect(delivered[0]?.fields.routingKey).toBe('queue.ticket.created');
      } finally {
        await model.close();
      }
    } finally {
      await publisher.close();
      await deleteVhost(LATE_VHOST);
    }
  });
});

describe('worker lifecycle', () => {
  it('processes events published before the worker started, then stops gracefully', async () => {
    const queued = ticketCreated({}, scope);
    await h.publish(queued);
    await waitFor(async () =>
      (await messageCount(h.inspect, NOTIFICATIONS_QUEUE)) === 1 ? true : undefined,
    );

    h.worker.start();
    expect(await h.worker.waitUntilReady(10_000)).toBe(true);
    await waitFor(async () =>
      (await logsOf(h.pool, scope.tenant.id)).some((row) => row.event_id === queued.event_id)
        ? true
        : undefined,
    );

    // A slow send in flight when stop() is called still completes and is acked.
    h.adapter.delayMs = 500;
    const inFlight = ticketCreated({ ticket_number: 'A-014' }, scope);
    await h.publish(inFlight);
    await waitFor(
      () => (h.worker.inFlightCount > 0 ? true : undefined),
      5_000,
      'message in flight',
    );
    await h.worker.stop();
    expect(h.worker.ready).toBe(false);

    const log = (await logsOf(h.pool, scope.tenant.id)).find(
      (row) => row.event_id === inFlight.event_id,
    );
    expect(log?.delivery_status).toBe('SENT');
    // Acked before the channel closed: nothing is redelivered.
    expect(await messageCount(h.inspect, NOTIFICATIONS_QUEUE)).toBe(0);
  });
});
