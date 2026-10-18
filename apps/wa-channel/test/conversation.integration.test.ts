// End-to-end conversation through the real pieces: signed webhook -> wa.message.received ->
// wa.inbound -> conversation (Redis session) -> core services /internal/v1 (PostgreSQL, Redis
// locks) -> wa.reply.requested / domain events (S09).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KEYS } from '../src/store.js';
import {
  CAPTURE,
  createHarness,
  expectNothing,
  newPhone,
  optionIds,
  say,
  setupWaFixture,
  take,
  waitFor,
  type Harness,
  type WaFixture,
} from './helpers.js';

let harness: Harness;
let fixture: WaFixture;

beforeAll(async () => {
  harness = await createHarness();
  fixture = await setupWaFixture(harness.core);
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  for (const queue of Object.values(CAPTURE)) await harness.channel.purgeQueue(queue);
  harness.core.events.clear();
});

function internal(tenantId: string) {
  return {
    authorization: `Bearer ${harness.core.waChannelToken}`,
    'x-antre-tenant-id': tenantId,
  };
}

async function activeTicket(phone: string) {
  const response = await harness.core.app.inject({
    method: 'GET',
    url: `/internal/v1/queues/tickets/active?location_id=${fixture.locationId}&customer_phone=${phone}`,
    headers: internal(fixture.tenantId),
  });
  return response.json<{ ticket: { id: string; ticket_number: string; status: string } | null }>()
    .ticket;
}

async function activeBookings(phone: string) {
  const response = await harness.core.app.inject({
    method: 'GET',
    url: `/internal/v1/bookings/active?location_id=${fixture.locationId}&customer_phone=${phone}`,
    headers: internal(fixture.tenantId),
  });
  return response.json<{ bookings: { id: string; status: string; service_id: string }[] }>()
    .bookings;
}

function keyword(): { text: string } {
  return { text: `ANTRE ${fixture.slug.toUpperCase()} ${fixture.locationCode}` };
}

/** Takes a walk-in ticket for `phone` through the conversation. */
async function takeTicket(phone: string): Promise<void> {
  await say(harness, phone, keyword());
  await say(harness, phone, { replyId: 'menu:walkin' });
  await say(harness, phone, { replyId: `svc:${fixture.serviceId}` }, false);
}

/** Holds the first free slot of the DP service for `phone` through the conversation. */
async function holdSlot(phone: string): Promise<void> {
  await say(harness, phone, keyword());
  await say(harness, phone, { replyId: 'menu:booking' });
  const dates = await say(harness, phone, { replyId: `svc:${fixture.dpServiceId}` });
  // Today may have no free slot left; the first offered date always has one.
  const slots = await say(harness, phone, { replyId: optionIds(dates)[0]! });
  await say(harness, phone, { replyId: optionIds(slots)[0]! }, false);
}

describe('QR keyword -> menu -> ticket (FR-WA-03, FR-WA-04, FR-QUEUE-01)', () => {
  it('creates the ticket with the sender number; the confirmation is the domain event', async () => {
    const phone = newPhone();
    const menu = await say(harness, phone, keyword());
    expect(menu?.tenant).toEqual({ id: fixture.tenantId, name: fixture.tenantName });
    expect(menu?.location).toEqual({ id: fixture.locationId, code: fixture.locationCode });
    expect(menu?.data.to).toBe(phone);
    expect(optionIds(menu)).toEqual(['menu:walkin', 'menu:booking', 'menu:status']);
    expect(menu?.data.message.body).toContain(`Selamat datang di ${fixture.tenantName}`);

    const session = await harness.runtime.store.get(KEYS.session(phone));
    expect(JSON.parse(session!)).toMatchObject({ tenant: { id: fixture.tenantId }, step: 'MENU' });

    const services = await say(harness, phone, { text: '1' });
    // Sorted by name: "Konsultasi DP", "Poli Umum".
    expect(optionIds(services)).toEqual([`svc:${fixture.dpServiceId}`, `svc:${fixture.serviceId}`]);

    await say(harness, phone, { text: 'poli umum' }, false);
    const ticket = await activeTicket(phone);
    expect(ticket).toMatchObject({ ticket_number: 'A-001', status: 'WAITING' });
    const created = harness.core.events.events.filter(
      (event) => event.event_type === 'queue.ticket.created',
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tenant: { id: fixture.tenantId },
      data: { customer_phone: phone, customer_name: 'Budi Santoso', channel: 'WHATSAPP' },
    });

    // A second ticket on the same day is refused with the status of the first one.
    await say(harness, phone, { text: '1' });
    const again = await say(harness, phone, { text: '2' });
    expect(again?.data.message.body).toContain('sudah memiliki antrean aktif');
    expect(again?.data.message.body).toContain('A-001');
  });
});

describe('reservation up to the hold (FR-WA-05)', () => {
  it('service -> date -> slot -> PENDING_PAYMENT hold with a lock', async () => {
    const phone = newPhone();
    await say(harness, phone, keyword());
    await say(harness, phone, { replyId: 'menu:booking' });
    const dates = await say(harness, phone, { replyId: `svc:${fixture.dpServiceId}` });
    expect(dates?.data.message.kind).toBe('list');
    expect(optionIds(dates).length).toBeGreaterThanOrEqual(6);
    expect(optionIds(dates).every((id) => id.startsWith('date:'))).toBe(true);

    const slots = await say(harness, phone, { replyId: optionIds(dates)[1]! });
    expect(optionIds(slots)).toHaveLength(10);
    expect(optionIds(slots).at(-1)).toBe('more');
    const next = await say(harness, phone, { text: 'Slot berikutnya' });
    expect(optionIds(next)[0]).toMatch(/^slot:/);

    const slotStart = optionIds(next)[0]!.slice('slot:'.length);
    await say(harness, phone, { replyId: optionIds(next)[0]! }, false);
    const [booking] = await activeBookings(phone);
    expect(booking).toMatchObject({ status: 'PENDING_PAYMENT', service_id: fixture.dpServiceId });
    const held = harness.core.events.events.filter(
      (event) => event.event_type === 'booking.reservation.held',
    );
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      data: { customer_phone: phone, start_time: expect.any(String) },
    });
    expect(Date.parse((held[0]!.data as { start_time: string }).start_time)).toBe(
      Date.parse(slotStart),
    );
  });
});

describe('STATUS and BATAL after the session expired (FR-WA-06)', () => {
  it('finds the items by the sender number and cancels the chosen one', async () => {
    const phone = newPhone();
    await takeTicket(phone);
    await holdSlot(phone);
    const ticket = (await activeTicket(phone))!;
    // The session expires (TTL): STATUS and BATAL still work.
    await harness.runtime.store.delete(KEYS.session(phone));

    const status = await say(harness, phone, { text: 'status' });
    expect(status?.tenant?.id).toBe(fixture.tenantId);
    expect(status?.data.message.kind).toBe('text');
    expect(status?.data.message.body).toContain(
      `Antrean *${ticket.ticket_number}* (Poli Umum): menunggu`,
    );
    expect(status?.data.message.body).toContain('Reservasi Konsultasi DP');
    expect(status?.data.message.body).toContain('menunggu pembayaran DP Rp50.000');
    expect(await harness.runtime.store.get(KEYS.session(phone))).toBeNull();

    const choice = await say(harness, phone, { text: 'BATAL' });
    expect(optionIds(choice)).toEqual(['cancel:1', 'cancel:2']);
    const cancelled = await say(harness, phone, { text: '1' });
    expect(cancelled?.data.message.body).toBe(
      `Antrean ${ticket.ticket_number} di ${fixture.tenantName} sudah dibatalkan. Terima kasih telah memberi tahu kami.`,
    );
    expect(await activeTicket(phone)).toBeNull();

    // One item left: BATAL cancels the booking directly; the template confirms it.
    await say(harness, phone, { text: 'batal' }, false);
    expect(await activeBookings(phone)).toEqual([]);
    expect(
      harness.core.events.events.some(
        (event) => event.event_type === 'booking.reservation.cancelled',
      ),
    ).toBe(true);
  });
});

describe('number without session', () => {
  it('answers anything that is not a keyword with the scan-QR hint, tenant null', async () => {
    const reply = await say(harness, newPhone(), { text: 'halo, saya mau antre' });
    expect(reply?.tenant).toBeNull();
    expect(reply?.location).toBeNull();
    expect(reply?.data.message.body).toContain('pindai (scan) kode QR');

    const unknown = await say(harness, newPhone(), { text: `ANTRE ${fixture.slug} cabang-lain` });
    expect(unknown?.tenant).toBeNull();
    expect(unknown?.data.message.body).toContain('tidak kami kenali');
  });

  it('STATUS of a number without items gives the hint too', async () => {
    const reply = await say(harness, newPhone(), { text: 'STATUS' });
    expect(reply?.data.message.body).toContain('tidak memiliki antrean atau reservasi');
    await expectNothing(harness, CAPTURE.replies, 100);
  });
});

describe('session lifetime (FR-WA-03)', () => {
  it('stores the session with the configured TTL', async () => {
    const phone = newPhone();
    await say(harness, phone, keyword());
    await waitFor(
      async () => (await harness.runtime.store.get(KEYS.session(phone))) !== null,
      2_000,
      'session not stored',
    );
    expect(harness.config.sessionTtlSeconds).toBe(1800);
    const events = await take(harness, CAPTURE.inbound, 1);
    expect(events[0]?.event_type).toBe('wa.message.received');
  });
});
