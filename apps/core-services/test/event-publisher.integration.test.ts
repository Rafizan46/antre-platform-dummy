// FR-NOTIF-01 / NFR-RELI-01: with the real RabbitMQ publisher and the broker unreachable, requests
// still succeed without waiting for the broker; their events wait in the publisher buffer.
import { RabbitEventPublisher } from '@antre/messaging';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiRequest,
  createTestApp,
  internalHeaders,
  setupQueueFixture,
  type TestApp,
} from './helpers.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let ctx: TestApp;
let publisher: RabbitEventPublisher;

beforeAll(async () => {
  publisher = new RabbitEventPublisher({
    // Nothing listens on port 1: every connection attempt is refused.
    url: 'amqp://guest:guest@127.0.0.1:1',
    name: 'core-services-test',
    log: silent,
    reconnect: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
    connectTimeoutMs: 1_000,
  });
  publisher.start();
  ctx = await createTestApp({ publisher });
});

afterAll(async () => {
  await ctx.close();
  await publisher.close(10);
});

describe('event publishing with the broker down', () => {
  it('creates tickets (staff and WhatsApp) and buffers their events', async () => {
    const f = await setupQueueFixture(ctx);

    const started = Date.now();
    const staff = await apiRequest(ctx.app, 'POST', '/api/v1/queues/tickets', f.owner, {
      location_id: f.locationId,
      service_id: f.serviceId,
      customer_name: 'Budi',
    });
    const whatsapp = await apiRequest(
      ctx.app,
      'POST',
      '/internal/v1/queues/tickets',
      internalHeaders(ctx, f.tenant.tenantId),
      {
        location_id: f.locationId,
        service_id: f.serviceId,
        customer_name: 'Siti',
        customer_phone: '6281234567890',
      },
    );
    const elapsed = Date.now() - started;

    expect(staff.statusCode).toBe(201);
    expect(whatsapp.statusCode).toBe(201);
    // No request waited for a connection or a confirm timeout.
    expect(elapsed).toBeLessThan(1_500);
    expect(publisher.connected).toBe(false);
    expect(publisher.stats().buffered).toBeGreaterThanOrEqual(2);
    expect(publisher.stats().published).toBe(0);

    const call = await apiRequest(ctx.app, 'POST', '/api/v1/queues/tickets/call-next', f.caller, {
      location_id: f.locationId,
      service_id: f.serviceId,
      resource_id: f.resourceId,
    });
    expect(call.statusCode).toBe(200);
  });
});
