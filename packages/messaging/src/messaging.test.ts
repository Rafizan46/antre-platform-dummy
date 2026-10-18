import { EventEmitter } from 'node:events';

import { createEvent } from '@antre/event-contracts';
import type { Channel, ConfirmChannel } from 'amqplib';
import { describe, expect, it } from 'vitest';

import {
  EVENT_EXCHANGE,
  NOTIFICATION_ROUTING_KEYS,
  NOTIFICATIONS_DLQ,
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_RETRY_QUEUES,
  PublishTimeoutError,
  RabbitEventPublisher,
  WA_INBOUND_DLQ,
  WA_INBOUND_QUEUE,
  WA_INBOUND_RETRY_QUEUES,
  assertTopology,
  describeBroker,
  eventMessageOptions,
  publishConfirmed,
  reconnectDelay,
} from './index.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function sampleEvent() {
  return createEvent(
    'queue.ticket.cancelled',
    {
      tenant: { id: 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1', name: 'Klinik' },
      location: { id: '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90', code: 'pusat' },
      data: {
        ticket_id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
        ticket_number: 'A-001',
        customer_name: 'Budi',
        customer_phone: null,
        status: 'CANCELLED',
      },
    },
    { now: new Date('2026-10-18T03:00:00Z') },
  );
}

describe('topology', () => {
  it('declares the exchange, work queue, retry queues, DLQ, and bindings of spec 7.1', async () => {
    const calls: unknown[][] = [];
    const recorder =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return {};
      };
    const channel = {
      assertExchange: recorder('exchange'),
      assertQueue: recorder('queue'),
      bindQueue: recorder('bind'),
    } as unknown as Channel;

    await assertTopology(channel);

    expect(calls[0]).toEqual(['exchange', EVENT_EXCHANGE, 'topic', { durable: true }]);
    expect(calls).toContainEqual(['queue', NOTIFICATIONS_DLQ, { durable: true }]);
    expect(calls).toContainEqual([
      'queue',
      NOTIFICATIONS_QUEUE,
      { durable: true, deadLetterExchange: '', deadLetterRoutingKey: NOTIFICATIONS_DLQ },
    ]);
    for (const queue of NOTIFICATIONS_RETRY_QUEUES) {
      expect(calls).toContainEqual([
        'queue',
        queue,
        { durable: true, deadLetterExchange: '', deadLetterRoutingKey: NOTIFICATIONS_QUEUE },
      ]);
    }
    const bindingsOf = (queue: string) =>
      calls.filter((call) => call[0] === 'bind' && call[1] === queue).map((call) => call[3]);
    const bindings = bindingsOf(NOTIFICATIONS_QUEUE);
    expect(bindings).toEqual([...NOTIFICATION_ROUTING_KEYS]);
    // Events without a consumer in the catalog have no binding (spec 7.1).
    expect(bindings).not.toContain('queue.ticket.cancelled');
    expect(bindings).not.toContain('wa.message.received');
    // S09: the booking cancellation notice is sent by the worker.
    expect(bindings).toContain('booking.reservation.cancelled');
  });

  it('declares wa.inbound with its retry queues and DLQ, bound to wa.message.received only', async () => {
    const calls: unknown[][] = [];
    const recorder =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return {};
      };
    const channel = {
      assertExchange: recorder('exchange'),
      assertQueue: recorder('queue'),
      bindQueue: recorder('bind'),
    } as unknown as Channel;

    await assertTopology(channel);

    expect(calls).toContainEqual(['queue', WA_INBOUND_DLQ, { durable: true }]);
    expect(calls).toContainEqual([
      'queue',
      WA_INBOUND_QUEUE,
      { durable: true, deadLetterExchange: '', deadLetterRoutingKey: WA_INBOUND_DLQ },
    ]);
    for (const queue of WA_INBOUND_RETRY_QUEUES) {
      expect(calls).toContainEqual([
        'queue',
        queue,
        { durable: true, deadLetterExchange: '', deadLetterRoutingKey: WA_INBOUND_QUEUE },
      ]);
    }
    const bindings = calls
      .filter((call) => call[0] === 'bind' && call[1] === WA_INBOUND_QUEUE)
      .map((call) => call[3]);
    expect(bindings).toEqual(['wa.message.received']);
  });
});

describe('connection helpers', () => {
  it('backs off exponentially up to the cap', () => {
    const options = { initialDelayMs: 500, maxDelayMs: 30_000 };
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => reconnectDelay(attempt, options))).toEqual([
      500, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(reconnectDelay(1000, options)).toBe(30_000);
  });

  it('describes a broker without its credentials', () => {
    expect(describeBroker('amqp://antre:secret@127.0.0.1:35672')).toBe('127.0.0.1:35672 vhost /');
    expect(describeBroker('amqps://u:p@broker.example/antre_it')).toBe(
      'broker.example:5671 vhost antre_it',
    );
    expect(describeBroker('not a url')).toBe('invalid url');
  });
});

describe('publisher', () => {
  it('sends persistent JSON with the event id as message id', () => {
    const event = sampleEvent();
    expect(eventMessageOptions(event, 'core-services')).toEqual({
      persistent: true,
      contentType: 'application/json',
      messageId: event.event_id,
      type: 'queue.ticket.cancelled',
      timestamp: Date.parse('2026-10-18T03:00:00Z') / 1000,
      appId: 'core-services',
      headers: { schema_version: 1 },
    });
  });

  it('resolves on a broker ack and rejects on a nack, a timeout, or a closed channel', async () => {
    const fake = (behaviour: 'ack' | 'nack' | 'silent' | 'throw') =>
      Object.assign(new EventEmitter(), {
        publish: (
          _exchange: string,
          _key: string,
          _content: Buffer,
          _options: unknown,
          callback: (error: unknown) => void,
        ) => {
          if (behaviour === 'throw') throw new Error('Channel closed');
          if (behaviour === 'ack') setImmediate(() => callback(null));
          if (behaviour === 'nack') setImmediate(() => callback(new Error('nacked')));
          return true;
        },
      }) as unknown as ConfirmChannel;
    const send = (channel: ConfirmChannel, timeout = 1000) =>
      publishConfirmed(channel, EVENT_EXCHANGE, 'x', Buffer.from('{}'), {}, timeout);

    await expect(send(fake('ack'))).resolves.toBeUndefined();
    await expect(send(fake('nack'))).rejects.toThrow('nacked');
    await expect(send(fake('silent'), 20)).rejects.toBeInstanceOf(PublishTimeoutError);
    await expect(send(fake('throw'))).rejects.toThrow('Channel closed');
  });

  it('never throws while the broker is unreachable: events are buffered, oldest dropped when full', async () => {
    const publisher = new RabbitEventPublisher({
      // Nothing listens on port 1: the connection is refused.
      url: 'amqp://guest:guest@127.0.0.1:1',
      name: 'test',
      log: silent,
      maxBufferedEvents: 2,
      reconnect: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
      connectTimeoutMs: 500,
    });
    publisher.start();
    const started = Date.now();
    await publisher.publish(sampleEvent());
    await publisher.publish(sampleEvent());
    await publisher.publish(sampleEvent());
    expect(Date.now() - started).toBeLessThan(200);
    expect(publisher.connected).toBe(false);
    expect(publisher.stats()).toEqual({ published: 0, buffered: 2, dropped: 1 });

    await publisher.close(10);
    expect(publisher.stats()).toEqual({ published: 0, buffered: 0, dropped: 3 });
  });
});
