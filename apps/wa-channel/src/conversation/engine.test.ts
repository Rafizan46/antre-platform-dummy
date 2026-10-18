import { createEvent } from '@antre/event-contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { CoreApiError, CoreUnavailableError } from '../core-client.js';
import { silentLogger } from '../logger.js';
import { InMemoryStore, KEYS } from '../store.js';
import {
  DP_SERVICE_ID,
  FakeCore,
  LOCATION_ID,
  OTHER_LOCATION_ID,
  OTHER_TENANT_ID,
  PHONE,
  SERVICE_ID,
  TENANT_ID,
} from '../testing.js';
import { ConversationEngine, MAX_INVALID_ANSWERS, type Reply } from './engine.js';
import { SessionStore } from './session.js';

const NOW = new Date('2026-10-19T03:00:00Z'); // Monday 10.00 WIB

let core: FakeCore;
let store: InMemoryStore;
let sessions: SessionStore;
let engine: ConversationEngine;
let clock: Date;

beforeEach(() => {
  clock = NOW;
  core = new FakeCore();
  store = new InMemoryStore({ now: () => clock.getTime() });
  sessions = new SessionStore(store, 1800);
  engine = new ConversationEngine({ core, sessions, log: silentLogger, now: () => clock });
});

async function send(
  text: string | null,
  options: { replyId?: string; type?: string; from?: string; name?: string | null } = {},
): Promise<Reply | null> {
  const reply = await engine.handle({
    from: options.from ?? PHONE,
    profileName: options.name === undefined ? 'Budi Santoso' : options.name,
    type: options.type ?? (options.replyId ? 'interactive' : 'text'),
    text,
    replyId: options.replyId ?? null,
  });
  if (reply !== null) {
    // Every reply must satisfy the wa.reply.requested contract (lengths, counts).
    createEvent('wa.reply.requested', {
      tenant: reply.tenant,
      location: reply.location,
      data: { to: options.from ?? PHONE, message: reply.message },
    });
  }
  return reply;
}

function bodyOf(reply: Reply | null): string {
  if (reply === null) throw new Error('expected a reply');
  return reply.message.body;
}

function optionIds(reply: Reply | null): string[] {
  const message = reply?.message;
  if (message?.kind === 'buttons') return message.buttons.map((button) => button.id);
  if (message?.kind === 'list') return message.rows.map((row) => row.id);
  return [];
}

describe('keyword and main menu (FR-WA-03, FR-WA-04)', () => {
  it('resolves the QR keyword, stores a session, and sends the menu of the service mode', async () => {
    const reply = await send('  antre KLINIK-SEHAT Pusat ');
    expect(core.callsOf('resolveLocation')).toEqual([['klinik-sehat', 'pusat']]);
    expect(reply?.tenant).toEqual({ id: TENANT_ID, name: 'Klinik Sehat' });
    expect(reply?.location).toEqual({ id: LOCATION_ID, code: 'pusat' });
    expect(reply?.message.kind).toBe('buttons');
    expect(optionIds(reply)).toEqual(['menu:walkin', 'menu:booking', 'menu:status']);
    expect(bodyOf(reply)).toContain('Selamat datang di Klinik Sehat (Cabang Pusat).');
    expect(bodyOf(reply)).toContain('1. Ambil Antrean\n2. Reservasi\n3. Cek Status');

    const session = await sessions.load(PHONE);
    expect(session).toMatchObject({ tenant: { id: TENANT_ID }, step: 'MENU' });
    expect(store.ttl(KEYS.session(PHONE))).toBe(1800 * 1000);
  });

  it('uses the branding greeting and hides options the service mode does not offer', async () => {
    core.context.service_mode = 'WALK_IN';
    core.context.branding.wa_greeting = 'Halo, selamat datang di Klinik Sehat!';
    const walkIn = await send('ANTRE klinik-sehat pusat');
    expect(optionIds(walkIn)).toEqual(['menu:walkin', 'menu:status']);
    expect(bodyOf(walkIn)).toContain('Halo, selamat datang di Klinik Sehat!');

    core.context.service_mode = 'RESERVATION';
    expect(optionIds(await send('ANTRE klinik-sehat pusat'))).toEqual([
      'menu:booking',
      'menu:status',
    ]);
  });

  it('answers unknown locations and malformed keywords with the scan-QR hint, without tenant', async () => {
    const unknown = await send('ANTRE klinik-sehat cabang-x');
    expect(unknown?.tenant).toBeNull();
    expect(bodyOf(unknown)).toContain('tidak kami kenali');
    expect(await sessions.load(PHONE)).toBeNull();

    const malformed = await send('ANTRE');
    expect(bodyOf(malformed)).toContain('tidak kami kenali');
    expect(core.callsOf('resolveLocation')).toHaveLength(1);

    core.context.location.is_active = false;
    expect(bodyOf(await send('ANTRE klinik-sehat pusat'))).toContain('tidak kami kenali');
  });

  it('answers any other message of a number without session with the scan-QR hint', async () => {
    const reply = await send('halo, mau antre');
    expect(reply?.tenant).toBeNull();
    expect(bodyOf(reply)).toContain('pindai (scan) kode QR');
    expect(await sessions.load(PHONE)).toBeNull();

    expect(bodyOf(await send('MENU'))).toContain('pindai (scan) kode QR');
  });

  it('a new keyword replaces the session of another location', async () => {
    await send('ANTRE klinik-sehat pusat');
    const reply = await send('ANTRE gor-juara utama');
    expect(reply?.tenant?.id).toBe(OTHER_TENANT_ID);
    expect((await sessions.load(PHONE))?.location?.id).toBe(OTHER_LOCATION_ID);
  });

  it('restarts the session TTL on every message', async () => {
    await send('ANTRE klinik-sehat pusat');
    clock = new Date(NOW.getTime() + 20 * 60_000);
    await send('BANTUAN');
    expect(store.ttl(KEYS.session(PHONE))).toBe(1800 * 1000);
    clock = new Date(NOW.getTime() + 51 * 60_000);
    expect(await sessions.load(PHONE)).toBeNull();
  });
});

describe('walk-in ticket (FR-WA-04, FR-QUEUE-01)', () => {
  it('lists the services and takes a ticket with the sender number and profile name', async () => {
    await send('ANTRE klinik-sehat pusat');
    const services = await send('1');
    expect(services?.message.kind).toBe('buttons');
    expect(optionIds(services)).toEqual([`svc:${SERVICE_ID}`, `svc:${DP_SERVICE_ID}`]);
    expect(bodyOf(services)).toContain('1. Poli Umum\n2. Konsultasi Spesialis');

    const done = await send(null, { replyId: `svc:${SERVICE_ID}` });
    // The confirmation comes from queue.ticket.created (template), not from the conversation.
    expect(done).toBeNull();
    expect(core.callsOf('createTicket')).toEqual([
      [
        TENANT_ID,
        {
          location_id: LOCATION_ID,
          service_id: SERVICE_ID,
          customer_phone: PHONE,
          customer_name: 'Budi Santoso',
        },
      ],
    ]);
    expect((await sessions.load(PHONE))?.step).toBe('MENU');
  });

  it('accepts the option title as text and falls back to "Pelanggan" without a profile name', async () => {
    await send('ANTRE klinik-sehat pusat');
    await send('ambil antrean');
    await send('poli umum', { name: null });
    expect(core.callsOf('createTicket')[0]?.[1]).toMatchObject({ customer_name: 'Pelanggan' });
  });

  it('answers an existing active ticket with its status (409 ACTIVE_TICKET_EXISTS)', async () => {
    await send('ANTRE klinik-sehat pusat');
    await send('1');
    await send('1');
    await send('1');
    const reply = await send('1');
    expect(bodyOf(reply)).toContain('sudah memiliki antrean aktif');
    expect(bodyOf(reply)).toContain(
      'Antrean *A-001* (Poli Umum): menunggu, 2 antrean di depan Anda',
    );
    expect(bodyOf(reply)).toContain('sekitar pukul 10.20 WIB');
  });

  it('maps quota, closed location, and disabled mode to customer messages', async () => {
    await send('ANTRE klinik-sehat pusat');
    await send('1');
    core.failNext('createTicket', new CoreApiError(402, 'QUOTA_EXCEEDED', 'habis'));
    expect(bodyOf(await send('1'))).toBe(
      'Maaf, antrean online di lokasi ini sedang tidak tersedia. Silakan menghubungi petugas di lokasi.',
    );

    await send('1');
    core.failNext('createTicket', new CoreApiError(409, 'LOCATION_CLOSED', 'tutup'));
    expect(bodyOf(await send('1'))).toContain('lokasi sedang tutup');

    await send('1');
    core.context.service_mode = 'RESERVATION';
    core.failNext('createTicket', new CoreApiError(409, 'MODE_DISABLED', 'mode'));
    const disabled = await send('1');
    expect(bodyOf(disabled)).toContain('Antrean langsung tidak tersedia di lokasi ini.');
    expect(optionIds(disabled)).toEqual(['menu:booking', 'menu:status']);
  });

  it('pages a long service list: 9 rows plus "Layanan berikutnya"', async () => {
    core.services = Array.from({ length: 12 }, (_, index) => ({
      ...core.services[0]!,
      id: `00000000-0000-4000-8000-1000000000${String(index).padStart(2, '0')}`,
      name: `Layanan nomor ${index + 1} dengan nama yang panjang sekali`,
    }));
    await send('ANTRE klinik-sehat pusat');
    const first = await send('1');
    expect(first?.message.kind).toBe('list');
    expect(optionIds(first)).toHaveLength(10);
    expect(optionIds(first).at(-1)).toBe('more');
    const second = await send('10');
    expect(optionIds(second)).toHaveLength(3);
    expect(bodyOf(second)).toContain('1. Layanan nomor 10');
  });

  it('propagates an unavailable core so the message is retried, keeping the session', async () => {
    await send('ANTRE klinik-sehat pusat');
    core.failNext('listServices', new CoreUnavailableError('down'));
    await expect(send('1')).rejects.toBeInstanceOf(CoreUnavailableError);
    expect((await sessions.load(PHONE))?.step).toBe('MENU');
  });
});

describe('reservation (FR-WA-05)', () => {
  beforeEach(() => {
    core.slots.set('2026-10-20', [
      { start_time: '2026-10-20T03:00:00.000Z', end_time: '2026-10-20T03:30:00.000Z' },
      { start_time: '2026-10-20T03:30:00.000Z', end_time: '2026-10-20T04:00:00.000Z' },
    ]);
    core.slots.set(
      '2026-10-22',
      Array.from({ length: 12 }, (_, index) => {
        const start = Date.parse('2026-10-22T01:00:00.000Z') + index * 30 * 60_000;
        return {
          start_time: new Date(start).toISOString(),
          end_time: new Date(start + 30 * 60_000).toISOString(),
        };
      }),
    );
  });

  it('service -> dates with free slots in the next 7 days -> slots -> hold', async () => {
    await send('ANTRE klinik-sehat pusat');
    const services = await send('2');
    expect(bodyOf(services)).toContain('2. Konsultasi Spesialis (DP Rp50.000)');

    const dates = await send('2');
    expect(core.callsOf('availableSlots').map((call) => call[3])).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    expect(dates?.message.kind).toBe('buttons');
    expect(optionIds(dates)).toEqual(['date:2026-10-20', 'date:2026-10-22']);
    expect(bodyOf(dates)).toContain('1. Selasa, 20 Oktober 2026 (2 slot)');

    const slots = await send('1');
    expect(optionIds(slots)).toEqual([
      'slot:2026-10-20T03:00:00.000Z',
      'slot:2026-10-20T03:30:00.000Z',
    ]);
    expect(bodyOf(slots)).toContain('1. 10.00-10.30 WIB');

    expect(await send('1')).toBeNull();
    expect(core.callsOf('createHold')).toEqual([
      [
        TENANT_ID,
        {
          location_id: LOCATION_ID,
          service_id: DP_SERVICE_ID,
          slot_start: '2026-10-20T03:00:00.000Z',
          customer_name: 'Budi Santoso',
          customer_phone: PHONE,
        },
      ],
    ]);
  });

  it('pages slots: 9 per page and "Slot berikutnya"', async () => {
    await send('ANTRE klinik-sehat pusat');
    await send('2');
    await send('1');
    const first = await send(null, { replyId: 'date:2026-10-22' });
    expect(first?.message.kind).toBe('list');
    expect(optionIds(first)).toHaveLength(10);
    const second = await send('Slot berikutnya');
    expect(optionIds(second)).toHaveLength(3);
    expect(optionIds(second)[0]).toBe('slot:2026-10-22T05:30:00.000Z');
  });

  it('asks for another slot after 409 SLOT_LOCKED', async () => {
    await send('ANTRE klinik-sehat pusat');
    await send('2');
    await send('1');
    await send('1');
    core.failNext('createHold', new CoreApiError(409, 'SLOT_LOCKED', 'ditahan'));
    const reply = await send('1');
    expect(bodyOf(reply)).toContain('slot itu baru saja diambil');
    expect((await sessions.load(PHONE))?.step).toBe('BOOKING_SLOT');
  });

  it('says so when no slot is free in the next 7 days', async () => {
    core.slots.clear();
    await send('ANTRE klinik-sehat pusat');
    await send('2');
    const reply = await send('1');
    expect(bodyOf(reply)).toContain('Belum ada slot kosong');
    expect((await sessions.load(PHONE))?.step).toBe('BOOKING_SERVICE');
  });
});

describe('STATUS and BATAL without session (FR-WA-06)', () => {
  async function takeTicketAndBooking(): Promise<void> {
    core.slots.set('2026-10-20', [
      { start_time: '2026-10-20T03:00:00.000Z', end_time: '2026-10-20T03:30:00.000Z' },
    ]);
    await send('ANTRE klinik-sehat pusat');
    await send('1');
    await send('1');
    await send('ANTRE gor-juara utama');
    core.otherContext.service_mode = 'RESERVATION';
    await send('1'); // Reservasi
    core.services = [core.services[0]!];
    await send('1'); // service
    await send('1'); // date
    await send('1'); // slot
    await sessions.delete(PHONE); // the session expired
  }

  it('STATUS lists all active items across tenants with tenant = null', async () => {
    await takeTicketAndBooking();
    const reply = await send('status');
    expect(reply?.tenant).toBeNull();
    const body = bodyOf(reply);
    expect(body).toContain('1. Klinik Sehat - Cabang Pusat\nAntrean *A-001* (Poli Umum): menunggu');
    expect(body).toContain(
      '2. GOR Juara - Utama\nReservasi Poli Umum (Lapangan: Ruang A), Selasa, 20 Oktober 2026 pukul 10.00 WIB: terkonfirmasi.',
    );
    expect(core.callsOf('activeItems')).toEqual([[PHONE]]);
    expect(await sessions.load(PHONE)).toBeNull();
  });

  it('STATUS hides the estimate when show_wait_estimate is false', async () => {
    core.context.show_wait_estimate = false;
    await send('ANTRE klinik-sehat pusat');
    await send('1');
    await send('1');
    const body = bodyOf(await send('STATUS'));
    expect(body).toContain('2 antrean di depan Anda.');
    expect(body).not.toContain('perkiraan');
  });

  it('STATUS without any item gives the scan-QR hint', async () => {
    const reply = await send('STATUS');
    expect(bodyOf(reply)).toContain('tidak memiliki antrean atau reservasi yang aktif');
    expect(bodyOf(reply)).toContain('pindai (scan) kode QR');
  });

  it('BATAL with several items offers a numbered choice and cancels the chosen one', async () => {
    await takeTicketAndBooking();
    const list = await send('BATAL');
    expect(list?.tenant).toBeNull();
    expect(optionIds(list)).toEqual(['cancel:1', 'cancel:2']);
    expect(bodyOf(list)).toContain('1. Antrean A-001 (Poli Umum) di Klinik Sehat');
    const session = await sessions.load(PHONE);
    expect(session).toMatchObject({ tenant: null, step: 'CANCEL_PICK' });

    const done = await send('1');
    expect(bodyOf(done)).toBe(
      'Antrean A-001 di Klinik Sehat sudah dibatalkan. Terima kasih telah memberi tahu kami.',
    );
    expect(done?.tenant?.id).toBe(TENANT_ID);
    expect(core.tickets[0]?.status).toBe('CANCELLED');
    expect(await sessions.load(PHONE)).toBeNull();
  });

  it('BATAL with one booking cancels it directly; the template confirms it', async () => {
    await takeTicketAndBooking();
    core.tickets[0]!.status = 'CALLED';
    expect(await send('batal')).toBeNull();
    expect(core.callsOf('cancelBooking')).toHaveLength(1);
    expect(core.bookings[0]?.status).toBe('CANCELLED');
  });

  it('BATAL of a ticket that is already called is refused', async () => {
    await send('ANTRE klinik-sehat pusat');
    await send('1');
    await send('1');
    core.tickets[0]!.status = 'CALLED';
    const reply = await send('BATAL');
    expect(bodyOf(reply)).toContain('tidak dapat dibatalkan lewat WhatsApp');
    expect(core.callsOf('cancelTicket')).toHaveLength(0);
  });

  it('BATAL answers a status change during the choice', async () => {
    await takeTicketAndBooking();
    await send('BATAL');
    core.failNext('cancelTicket', new CoreApiError(409, 'INVALID_TRANSITION', 'x'));
    expect(bodyOf(await send('1'))).toContain('tidak dapat dibatalkan lagi');
  });

  it('never takes the phone number from the message text', async () => {
    await send('STATUS 6289999999999');
    // "STATUS <text>" is not the command; the number in the text is ignored either way.
    expect(core.callsOf('activeItems')).toEqual([]);
    await send('STATUS', { from: '6289999999999' });
    expect(core.callsOf('activeItems')).toEqual([['6289999999999']]);
  });
});

describe('invalid input, help, stop, and unsupported messages', () => {
  it(`repeats the prompt and goes back to the menu after ${MAX_INVALID_ANSWERS} invalid answers`, async () => {
    await send('ANTRE klinik-sehat pusat');
    await send('1');
    const first = await send('99');
    expect(bodyOf(first)).toContain('Pilihan tidak dikenali. Balas dengan angka 1 sampai 2');
    expect(optionIds(first)).toEqual([`svc:${SERVICE_ID}`, `svc:${DP_SERVICE_ID}`]);
    await send('apa ya');
    const third = await send('xyz');
    expect(bodyOf(third)).toContain('kembalikan Anda ke menu utama');
    expect(optionIds(third)).toEqual(['menu:walkin', 'menu:booking', 'menu:status']);
    expect((await sessions.load(PHONE))?.invalid).toBe(0);
  });

  it('ignores a reply id that was not offered in the current prompt', async () => {
    await send('ANTRE klinik-sehat pusat');
    const reply = await send('x', { replyId: `svc:${SERVICE_ID}` });
    expect(bodyOf(reply)).toContain('Pilihan tidak dikenali');
    expect(core.callsOf('createTicket')).toHaveLength(0);
  });

  it('BANTUAN lists the commands; MENU returns to the main menu', async () => {
    expect(bodyOf(await send('bantuan'))).toContain('STATUS - cek antrean dan reservasi aktif');
    await send('ANTRE klinik-sehat pusat');
    await send('1');
    const menu = await send('Menu');
    expect(optionIds(menu)).toEqual(['menu:walkin', 'menu:booking', 'menu:status']);
  });

  it('STOP ends the session', async () => {
    await send('ANTRE klinik-sehat pusat');
    const reply = await send('STOP');
    expect(bodyOf(reply)).toContain('Sesi percakapan Anda telah diakhiri');
    expect(reply?.tenant?.id).toBe(TENANT_ID);
    expect(await sessions.load(PHONE)).toBeNull();
  });

  it('answers media politely and ignores reactions', async () => {
    const image = await send(null, { type: 'image' });
    expect(bodyOf(image)).toContain('hanya dapat membaca pesan teks');
    expect(await send(null, { type: 'reaction' })).toBeNull();
  });

  it('treats a corrupt stored session as no session', async () => {
    await store.set(KEYS.session(PHONE), '{"v":99}', 60_000);
    expect(bodyOf(await send('1'))).toContain('pindai (scan) kode QR');
  });
});
