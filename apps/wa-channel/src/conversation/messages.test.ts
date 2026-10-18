import { createEvent } from '@antre/event-contracts';
import { describe, expect, it } from 'vitest';

import { parseInput } from './commands.js';
import {
  addDays,
  clip,
  formatDateLong,
  formatDateShort,
  formatDateTime,
  formatRupiah,
  formatSlot,
  formatTime,
  localDate,
  truncate,
} from './format.js';
import {
  bookingLine,
  optionsMessage,
  paginate,
  statusText,
  textMessage,
  ticketLine,
  type StatusContext,
  type WaMessage,
} from './messages.js';

function valid(message: WaMessage): void {
  createEvent('wa.reply.requested', {
    tenant: null,
    location: null,
    data: { to: '6281234567890', message },
  });
}

describe('parseInput (FR-WA-03, FR-WA-06)', () => {
  it('recognises the QR keyword in any case and spacing', () => {
    expect(parseInput('ANTRE klinik-sehat pusat', null)).toEqual({
      kind: 'keyword',
      slug: 'klinik-sehat',
      code: 'pusat',
    });
    expect(parseInput('  antre   Klinik-Sehat   PUSAT  ', null)).toEqual({
      kind: 'keyword',
      slug: 'klinik-sehat',
      code: 'pusat',
    });
  });

  it('flags malformed keywords', () => {
    for (const text of ['ANTRE', 'antre klinik', 'ANTRE klinik_sehat pusat', 'ANTRE a b c']) {
      expect(parseInput(text, null)).toEqual({ kind: 'invalid-keyword' });
    }
    expect(parseInput('ANTREAN saya', null)).toEqual({ kind: 'answer' });
  });

  it('recognises the global commands and their aliases', () => {
    expect(parseInput('menu', null)).toEqual({ kind: 'command', command: 'MENU' });
    expect(parseInput(' Status ', null)).toEqual({ kind: 'command', command: 'STATUS' });
    expect(parseInput('cek  status', null)).toEqual({ kind: 'command', command: 'STATUS' });
    expect(parseInput('BATAL', null)).toEqual({ kind: 'command', command: 'BATAL' });
    expect(parseInput('bantuan', null)).toEqual({ kind: 'command', command: 'BANTUAN' });
    expect(parseInput('stop', null)).toEqual({ kind: 'command', command: 'STOP' });
    expect(parseInput(null, 'cmd:status')).toEqual({ kind: 'command', command: 'STATUS' });
    expect(parseInput('1', null)).toEqual({ kind: 'answer' });
    expect(parseInput('constructor', null)).toEqual({ kind: 'answer' });
    expect(parseInput(null, null)).toEqual({ kind: 'answer' });
  });
});

describe('Indonesian formatting', () => {
  it('formats times, dates, and amounts in the location time zone', () => {
    expect(formatTime('2026-10-19T03:20:00Z', 'Asia/Jakarta')).toBe('10.20 WIB');
    expect(formatTime('2026-10-19T03:20:00Z', 'Asia/Makassar')).toBe('11.20 WITA');
    expect(formatTime('2026-10-19T03:20:00Z', 'Asia/Jayapura')).toBe('12.20 WIT');
    expect(formatDateTime('2026-10-19T17:30:00Z', 'Asia/Jakarta')).toBe(
      'Selasa, 20 Oktober 2026 pukul 00.30 WIB',
    );
    expect(formatDateLong('2026-10-25')).toBe('Minggu, 25 Oktober 2026');
    expect(formatDateShort('2026-12-31')).toBe('Kam, 31 Des');
    expect(formatSlot('2026-10-20T03:00:00Z', '2026-10-20T03:30:00Z', 'Asia/Jakarta')).toBe(
      '10.00-10.30',
    );
    expect(formatRupiah(50000)).toBe('Rp50.000');
    expect(formatRupiah(1250000.5)).toBe('Rp1.250.000,5');
  });

  it('computes local dates and calendar arithmetic across month ends', () => {
    expect(localDate(new Date('2026-10-19T17:30:00Z'), 'Asia/Jakarta')).toBe('2026-10-20');
    expect(localDate(new Date('2026-10-19T16:30:00Z'), 'Asia/Jakarta')).toBe('2026-10-19');
    expect(addDays('2026-10-29', 3)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('clips to UTF-16 limits without splitting emoji', () => {
    expect(truncate('Konsultasi   Dokter\nSpesialis Anak', 24)).toBe('Konsultasi Dokter Spesi…');
    expect(truncate('Pendek', 24)).toBe('Pendek');
    const emoji = clip('😀😀😀😀', 5);
    expect(emoji.length).toBeLessThanOrEqual(5);
    expect(emoji).toBe('😀😀…');
  });
});

describe('message builders (FR-WA-07)', () => {
  const prompt = { intro: 'Silakan pilih:', footer: 'Balas dengan angka pilihan.' };

  it('uses buttons for up to 3 short options and lists them numbered in the body', () => {
    const message = optionsMessage(prompt, [
      { id: 'a', title: 'Ambil Antrean', label: 'Ambil Antrean' },
      { id: 'b', title: 'Reservasi', label: 'Reservasi' },
    ]);
    expect(message).toEqual({
      kind: 'buttons',
      body: 'Silakan pilih:\n\n1. Ambil Antrean\n2. Reservasi\n\nBalas dengan angka pilihan.',
      buttons: [
        { id: 'a', title: 'Ambil Antrean' },
        { id: 'b', title: 'Reservasi' },
      ],
    });
    valid(message);
  });

  it('uses a list for long titles or more than 3 options, within the row limits', () => {
    const long = 'Pemeriksaan Kesehatan Umum Lengkap dengan Dokter';
    const message = optionsMessage(
      prompt,
      Array.from({ length: 10 }, (_, index) => ({
        id: `svc:${index}`,
        title: `${long} ${index}`,
        label: `${long} ${index}`,
        description: 'x'.repeat(100),
      })),
      'Pilihan tidak dikenali.',
    );
    expect(message.kind).toBe('list');
    if (message.kind !== 'list') return;
    expect(message.rows).toHaveLength(10);
    expect(message.rows.every((row) => row.title.length <= 24)).toBe(true);
    expect(message.rows.every((row) => (row.description ?? '').length <= 72)).toBe(true);
    expect(message.body.startsWith('Pilihan tidak dikenali.\n\nSilakan pilih:')).toBe(true);
    expect(message.body).toContain(`10. ${long} 9`);
    valid(message);
  });

  it('keeps the numbered lines when the intro is too long for the body limit', () => {
    const message = optionsMessage({ intro: 'x'.repeat(2000), footer: 'footer' }, [
      { id: 'a', title: 'A', label: 'Pilihan A' },
    ]);
    expect(message.body.length).toBeLessThanOrEqual(1024);
    expect(message.body).toContain('1. Pilihan A\n\nfooter');
    valid(message);
  });

  it('refuses an empty or over-long option list', () => {
    expect(() => optionsMessage(prompt, [])).toThrow();
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      id: String(index),
      title: 't',
      label: 'l',
    }));
    expect(() => optionsMessage(prompt, eleven)).toThrow();
  });

  it('pages 9 items plus a next row when more than 10', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(paginate(items.slice(0, 10), 0)).toEqual({
      items: items.slice(0, 10),
      hasMore: false,
      page: 0,
    });
    expect(paginate(items, 0)).toEqual({ items: items.slice(0, 9), hasMore: true, page: 0 });
    expect(paginate(items, 2)).toEqual({ items: items.slice(18), hasMore: false, page: 2 });
    expect(paginate(items, 7)).toEqual({ items: items.slice(18), hasMore: false, page: 2 });
  });

  it('caps text messages at 4096 characters', () => {
    const message = textMessage('x'.repeat(5000));
    expect(message.body.length).toBe(4096);
    valid(message);
  });
});

describe('status lines (FR-WA-06)', () => {
  const context: StatusContext = {
    tenantName: 'GOR Juara',
    locationName: 'Utama',
    timeZone: 'Asia/Jakarta',
    showEstimate: true,
    resourceLabel: 'Lapangan',
  };
  const ticket = {
    id: 't',
    location_id: 'l',
    service_id: 's',
    service_name: 'Umum',
    resource_name: 'Loket 2',
    ticket_number: 'A-012',
    customer_name: 'Budi',
    customer_phone: '6281234567890',
    status: 'WAITING' as const,
    people_ahead: 4,
    estimated_serve_time: '2026-10-19T03:45:00Z',
  };
  const booking = {
    id: 'b',
    location_id: 'l',
    service_id: 's',
    service_name: 'Sewa Lapangan',
    resource_name: 'Lapangan 1',
    customer_name: 'Budi',
    customer_phone: '6281234567890',
    start_time: '2026-10-20T03:00:00Z',
    end_time: '2026-10-20T04:00:00Z',
    status: 'PENDING_PAYMENT' as const,
    payment_status: 'UNPAID' as const,
    dp_amount: 50000,
    payment_ref: 'pay-123',
    hold_expires_at: '2026-10-19T03:05:00Z',
  };

  it('describes tickets by status, with the estimate only when allowed', () => {
    expect(ticketLine(ticket, context)).toBe(
      'Antrean *A-012* (Umum): menunggu, 4 antrean di depan Anda, perkiraan giliran sekitar pukul 10.45 WIB.',
    );
    expect(ticketLine(ticket, { ...context, showEstimate: false })).toBe(
      'Antrean *A-012* (Umum): menunggu, 4 antrean di depan Anda.',
    );
    expect(ticketLine({ ...ticket, status: 'CALLED' }, context)).toContain(
      'sedang dipanggil di Loket 2',
    );
    expect(ticketLine({ ...ticket, status: 'SERVING' }, context)).toContain(
      'sedang dilayani di Loket 2',
    );
  });

  it('describes bookings waiting for the DP and confirmed ones', () => {
    expect(bookingLine(booking, context)).toBe(
      'Reservasi Sewa Lapangan (Lapangan: Lapangan 1), Selasa, 20 Oktober 2026 pukul 10.00 WIB: ' +
        'menunggu pembayaran DP Rp50.000 sebelum 10.05 WIB (kode pembayaran pay-123).',
    );
    expect(
      bookingLine({ ...booking, status: 'CONFIRMED', payment_status: 'PAID' }, context),
    ).toContain('terkonfirmasi, DP Rp50.000 lunas.');
    expect(
      statusText([
        { context, ticket },
        { context, booking },
      ]),
    ).toMatch(
      /^Status antrean dan reservasi Anda:\n\n1\. GOR Juara - Utama\nAntrean \*A-012\*.*\n\n2\. GOR Juara - Utama\nReservasi .*\n\nKetik BATAL untuk membatalkan\.$/s,
    );
  });
});
