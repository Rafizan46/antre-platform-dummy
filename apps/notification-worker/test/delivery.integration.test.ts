// Event -> WhatsApp message -> notification_logs, idempotency per event id, tenant isolation,
// untenanted replies, and delivery status updates (FR-NOTIF-01..04, FR-WA-02, spec 7.1).
import { NOTIFICATIONS_DLQ, NOTIFICATIONS_QUEUE, eventMessageOptions } from '@antre/messaging';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { METRIC_NAMES } from '../src/metrics.js';
import { sandboxMessageId } from '../src/whatsapp/sandbox.js';
import {
  bookingConfirmed,
  bookingReminder,
  quotaWarning,
  replyRequested,
  statusReceived,
  ticketCalled,
  ticketCreated,
} from './fixtures.js';
import {
  createHarness,
  createTenant,
  logsOf,
  messageCount,
  purgeQueues,
  sleep,
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
  scope = await createTenant(h.pool, {
    branding: { wa_greeting: 'Selamat datang di klinik kami!', labels: { resource: 'Dokter' } },
  });
});

async function sentLog(tenantId: string, eventId: string) {
  return waitFor(
    async () =>
      (await logsOf(h.pool, tenantId)).find(
        (row) => row.event_id === eventId && row.delivery_status === 'SENT',
      ),
    10_000,
    `SENT log of ${eventId}`,
  );
}

describe('delivery', () => {
  it('sends queue.ticket.created as a template and logs it under the tenant (FR-NOTIF-02)', async () => {
    const event = ticketCreated({}, scope);
    await h.publish(event);

    const log = await sentLog(scope.tenant.id, event.event_id);
    expect(log).toMatchObject({
      provider_message_id: sandboxMessageId(event.event_id),
      recipient_phone: '6281234567890',
      template_name: 'antre_ticket_created',
      retry_count: 0,
    });
    expect(log.sent_at).toBeInstanceOf(Date);
    expect(log.payload).toMatchObject({
      event_type: 'queue.ticket.created',
      template: 'antre_ticket_created',
      language: 'id',
    });

    expect(h.adapter.sent).toHaveLength(1);
    const content = h.adapter.sent[0]!.message.content;
    expect(content.kind).toBe('template');
    if (content.kind !== 'template') return;
    // Greeting from the tenant branding, location name and time zone from the database.
    expect(content.parameters).toEqual([
      'Budi Santoso',
      'Selamat datang di klinik kami!',
      'A-012',
      'Poli Umum',
      'Cabang Pusat',
      '4',
      'sekitar pukul 10.45 WIB',
    ]);
    await waitFor(async () =>
      (await messageCount(h.inspect, NOTIFICATIONS_QUEUE)) === 0 ? true : undefined,
    );
  });

  it('maps queue, booking, and billing events to their templates', async () => {
    const events = [ticketCalled(), bookingConfirmed(), bookingReminder(), quotaWarning()].map(
      (event) => ({ ...event, tenant: scope.tenant, location: scope.location }),
    );
    for (const event of events) await h.publish(event);

    for (const event of events) await sentLog(scope.tenant.id, event.event_id);
    const logs = await logsOf(h.pool, scope.tenant.id);
    expect(logs.map((row) => row.template_name).sort()).toEqual([
      'antre_booking_confirmed',
      'antre_booking_reminder',
      'antre_quota_warning',
      'antre_ticket_called',
    ]);
    expect(logs.find((row) => row.template_name === 'antre_quota_warning')?.recipient_phone).toBe(
      '6281111111111',
    );
    const confirmed = h.adapter.sent.find(
      (sent) =>
        sent.message.content.kind === 'template' &&
        sent.message.content.name === 'antre_booking_confirmed',
    );
    expect(
      confirmed?.message.content.kind === 'template' && confirmed.message.content.parameters[3],
    ).toBe('Dokter');
  });

  it('does not send a duplicated event (same event_id) twice', async () => {
    const event = ticketCreated({}, scope);
    await h.publish(event);
    await h.publish(event);
    await sentLog(scope.tenant.id, event.event_id);
    await waitFor(() => (h.metrics.total(METRIC_NAMES.duplicates) >= 1 ? true : undefined));

    // A redelivery after the first one was acked, published by hand.
    h.inspect.publish(
      '',
      NOTIFICATIONS_QUEUE,
      Buffer.from(JSON.stringify(event)),
      eventMessageOptions(event, 'test'),
    );
    await waitFor(() => (h.metrics.total(METRIC_NAMES.duplicates) >= 2 ? true : undefined));

    expect(h.adapter.sent).toHaveLength(1);
    const logs = await logsOf(h.pool, scope.tenant.id);
    expect(logs).toHaveLength(1);
  });

  it('keeps each log row inside its tenant (RLS)', async () => {
    const other = await createTenant(h.pool);
    const event = ticketCreated({}, scope);
    await h.publish(event);
    await sentLog(scope.tenant.id, event.event_id);
    expect(await logsOf(h.pool, other.tenant.id)).toEqual([]);
  });

  it('skips a ticket without a WhatsApp number and logs nothing', async () => {
    const event = ticketCreated({ customer_phone: null }, scope);
    await h.publish(event);
    await waitFor(() => (h.metrics.total(METRIC_NAMES.skipped) >= 1 ? true : undefined));
    expect(h.adapter.sent).toHaveLength(0);
    expect(await logsOf(h.pool, scope.tenant.id)).toEqual([]);
  });

  it('sends untenanted replies without a notification_logs row (spec 7.1)', async () => {
    const before = h.metrics.total(METRIC_NAMES.untenantedReplies);
    const untenanted = replyRequested(null);
    const tenanted = replyRequested(scope.tenant);
    await h.publish(untenanted);
    await h.publish(tenanted);

    await sentLog(scope.tenant.id, tenanted.event_id);
    await waitFor(() => (h.adapter.sent.length === 2 ? true : undefined));
    expect(h.metrics.total(METRIC_NAMES.untenantedReplies)).toBe(before + 1);
    const logs = await logsOf(h.pool, scope.tenant.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event_id: tenanted.event_id, template_name: null });
    expect(h.adapter.sent.map((sent) => sent.message.content.kind)).toEqual(['buttons', 'buttons']);
  });

  it('applies wa.status.received forward-only through app_wa_update_delivery_status', async () => {
    const event = ticketCreated({}, scope);
    await h.publish(event);
    const log = await sentLog(scope.tenant.id, event.event_id);
    const wamid = log.provider_message_id!;

    const statusOf = async () =>
      (await logsOf(h.pool, scope.tenant.id)).find((row) => row.event_id === event.event_id);

    await h.publish(statusReceived(wamid, 'DELIVERED'));
    await waitFor(async () =>
      (await statusOf())?.delivery_status === 'DELIVERED' ? true : undefined,
    );
    await h.publish(statusReceived(wamid, 'READ'));
    await waitFor(async () => ((await statusOf())?.delivery_status === 'READ' ? true : undefined));
    expect((await statusOf())?.status_updated_at).toBeInstanceOf(Date);

    // Backwards (READ -> DELIVERED) and unknown wamids change nothing and are acked.
    await h.publish(statusReceived(wamid, 'DELIVERED'));
    await h.publish(statusReceived('wamid.UNKNOWN', 'DELIVERED'));
    await waitFor(() => (h.metrics.total(METRIC_NAMES.statusUpdates) >= 4 ? true : undefined));
    await sleep(100);
    expect((await statusOf())?.delivery_status).toBe('READ');
    expect(await messageCount(h.inspect, NOTIFICATIONS_DLQ)).toBe(0);
  });
});
