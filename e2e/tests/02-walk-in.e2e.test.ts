// Journey (b): walk-in customers take a number on WhatsApp, staff call them, and the kiosk and the
// staff screen follow along in real time without ever seeing personal data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api } from '../src/api.js';
import { dropWaSession } from '../src/infra.js';
import { openStream, update, type SseConnection } from '../src/sse.js';
import { eventually, stack } from '../src/stack.js';
import { provisionTenant, type TenantFixture } from '../src/tenant.js';
import { WaCustomer } from '../src/wa.js';

describe('walk-in customer journey', () => {
  let tenant: TenantFixture;
  let staffStream: SseConnection;
  let kioskStream: SseConnection;
  const customerA = new WaCustomer();
  const customerB = new WaCustomer();
  let ticketAId: string;

  const listTickets = async (status?: string) => {
    const query = status === undefined ? '' : `&status=${status}`;
    const response = await api(
      'GET',
      `/api/v1/queues/tickets?location_id=${tenant.locationId}${query}`,
      {
        token: tenant.cashier.token,
      },
    );
    expect(response.status).toBe(200);
    return response.body.tickets as { id: string; ticket_number: string; status: string }[];
  };
  const callNext = () =>
    api('POST', '/api/v1/queues/tickets/call-next', {
      token: tenant.caller.token,
      body: {
        location_id: tenant.locationId,
        service_id: tenant.freeServiceId,
        resource_id: tenant.resourceIds[0],
      },
    });
  const action = (ticketId: string, name: string) =>
    api('POST', `/api/v1/queues/tickets/${ticketId}/actions`, {
      token: tenant.caller.token,
      body: { action: name },
    });
  const keyword = () => `ANTRE ${tenant.slug} ${tenant.locationCode}`;

  beforeAll(async () => {
    tenant = await provisionTenant({ prefix: 'walkin' });
    staffStream = await openStream(stack().realtimeUrl, tenant.locationId, tenant.caller.token);
    kioskStream = await openStream(stack().realtimeUrl, tenant.locationId, tenant.kioskToken);
    expect(staffStream.status).toBe(200);
    expect(kioskStream.status).toBe(200);
    await staffStream.waitFor((m) => m.event === 'snapshot', 'staff snapshot');
    await kioskStream.waitFor((m) => m.event === 'snapshot', 'kiosk snapshot');
  });

  afterAll(() => {
    staffStream?.close();
    kioskStream?.close();
  });

  it('customer A scans the QR code, sees the menu, picks a service and gets ticket A-001', async () => {
    const menu = await customerA.ask(keyword());
    expect(menu.text).toContain('Ambil Antrean');
    expect(menu.text).toContain('Reservasi');

    const services = await customerA.ask('1');
    expect(services.text).toContain('Konsultasi');
    expect(services.text).toContain('Perawatan');

    const ticket = await customerA.ask('1');
    expect(ticket.template).toBe('antre_ticket_created');
    expect(ticket.text).toContain('A-001');
    expect(ticket.text).toContain('Antrean di depan Anda: 0');
  });

  it('the ticket is in the staff API and was announced in real time without personal data', async () => {
    const tickets = await listTickets();
    const ticket = tickets.find((candidate) => candidate.ticket_number === 'A-001');
    expect(ticket?.status).toBe('WAITING');
    ticketAId = ticket!.id;

    for (const stream of [staffStream, kioskStream]) {
      const created = await stream.waitFor(
        update('queue.ticket.created', 'A-001'),
        'A-001 created',
      );
      expect(created.data.status).toBe('WAITING');
      expect(created.data.ticket_id).toBe(ticketAId);
      // The wire carries a ticket number and a service name, never who the customer is.
      expect(stream.raw()).not.toContain(customerA.phone);
      expect(stream.raw()).not.toContain('Pelanggan Uji');
      expect(stream.raw()).not.toMatch(/customer_(name|phone)/);
    }
  });

  it('customer B takes the next number', async () => {
    await customerB.ask(keyword());
    await customerB.ask('1');
    const ticket = await customerB.ask('1');
    expect(ticket.text).toContain('A-002');
    expect(ticket.text).toContain('Antrean di depan Anda: 1');
    await kioskStream.waitFor(update('queue.ticket.created', 'A-002'), 'A-002 created');
  });

  it('CALL_NEXT calls A-001: kiosk shows it and the customer is told to come', async () => {
    const called = await callNext();
    expect(called.status).toBe(200);
    expect(called.body.ticket.ticket_number).toBe('A-001');
    expect(called.body.ticket.status).toBe('CALLED');

    const onKiosk = await kioskStream.waitFor(
      update('queue.ticket.called', 'A-001'),
      'A-001 called',
    );
    expect(onKiosk.data.resource_name).toBe('Dokter 1');
    expect(onKiosk.data.is_recall).toBe(false);
    await staffStream.waitFor(update('queue.ticket.called', 'A-001'), 'A-001 called (staff)');

    const message = await customerA.nextReply(
      'call notification',
      (m) => m.template === 'antre_ticket_called',
    );
    expect(message.text).toContain('sedang dipanggil');
    expect(message.text).toContain('A-001');
    expect(kioskStream.raw()).not.toContain(customerA.phone);
  });

  it('RECALL announces again, SERVE and COMPLETE close the ticket', async () => {
    const recall = await action(ticketAId, 'RECALL');
    expect(recall.status).toBe(200);
    const again = await kioskStream.waitFor(
      (m) => update('queue.ticket.called', 'A-001')(m) && m.data.is_recall === true,
      'A-001 recalled',
    );
    expect(again.data.is_recall).toBe(true);

    expect((await action(ticketAId, 'SERVE')).status).toBe(200);
    expect((await listTickets()).find((t) => t.id === ticketAId)?.status).toBe('SERVING');
    expect((await action(ticketAId, 'COMPLETE')).status).toBe(200);
    expect((await listTickets()).find((t) => t.id === ticketAId)?.status).toBe('COMPLETED');

    // A finished ticket cannot be served again.
    expect((await action(ticketAId, 'SERVE')).status).toBe(409);
  });

  it('customer B checks the status, also after the WhatsApp session is gone', async () => {
    const status = await customerB.ask('STATUS');
    expect(status.text).toContain('A-002');
    expect(status.text).toContain('menunggu');

    // The 30 minute session expires (here: is deleted); STATUS needs no session.
    expect(await dropWaSession(customerB.phone)).toBeGreaterThanOrEqual(0);
    const afterExpiry = await customerB.ask('STATUS');
    expect(afterExpiry.text).toContain('A-002');
  });

  it('customer B cancels after the session is gone; the ticket is cancelled for staff', async () => {
    await dropWaSession(customerB.phone);
    // Only one active item, so BATAL cancels it directly.
    const done = await customerB.ask('BATAL');
    expect(done.text).toContain('A-002');
    expect(done.text).toMatch(/batal|dibatalkan/i);

    await eventually('A-002 cancelled in the staff API', async () => {
      const ticket = (await listTickets()).find((t) => t.ticket_number === 'A-002');
      return ticket?.status === 'CANCELLED';
    });
    await kioskStream.waitFor(update('queue.ticket.cancelled', 'A-002'), 'A-002 cancelled');
  });

  it('a finished customer asking for the status gets the polite hint, not an error', async () => {
    const reply = await customerA.ask('STATUS');
    expect(reply.text.length).toBeGreaterThan(10);
  });
});
