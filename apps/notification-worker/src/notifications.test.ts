import { NOTIFICATION_ROUTING_KEYS } from '@antre/messaging';
import { describe, expect, it } from 'vitest';

import {
  bookingCancelled,
  bookingConfirmed,
  bookingExpired,
  bookingHeld,
  bookingReminder,
  quotaExceeded,
  quotaWarning,
  replyRequested,
  statusReceived,
  subscriptionActivated,
  ticketCalled,
  ticketCreated,
  ticketNearTurn,
  TENANT,
} from '../test/fixtures.js';
import {
  buildNotification,
  fallbackContext,
  isMessageEvent,
  type NotificationContext,
} from './notifications.js';
import type { TemplateMessage } from './whatsapp/adapter.js';

const CONTEXT: NotificationContext = {
  tenantName: 'Klinik Pratama Sehat',
  greeting: null,
  resourceLabel: null,
  locationName: 'Cabang Pusat',
  timeZone: 'Asia/Jakarta',
};

function templateOf(planned: ReturnType<typeof buildNotification>): TemplateMessage {
  if (planned === null || planned.message.content.kind !== 'template') {
    throw new Error('expected a template message');
  }
  return planned.message.content;
}

describe('buildNotification', () => {
  it('maps every bound routing key except wa.status.received to a message', () => {
    const bound = NOTIFICATION_ROUTING_KEYS.filter((key) => key !== 'wa.status.received');
    expect(bound).toHaveLength(12);
    expect(isMessageEvent(bookingCancelled())).toBe(true);
    expect(isMessageEvent(statusReceived('wamid.X', 'DELIVERED'))).toBe(false);
    expect(isMessageEvent(ticketCreated())).toBe(true);
  });

  it('queue.ticket.created: number, service, people ahead, estimate, STATUS/BATAL (FR-NOTIF-02)', () => {
    const planned = buildNotification(ticketCreated(), CONTEXT, 'id');
    expect(planned?.templateName).toBe('antre_ticket_created');
    expect(planned?.message.to).toBe('6281234567890');
    const content = templateOf(planned);
    expect(content.parameters).toEqual([
      'Budi Santoso',
      'terima kasih telah mengambil antrean di Klinik Pratama Sehat.',
      'A-012',
      'Poli Umum',
      'Cabang Pusat',
      '4',
      'sekitar pukul 10.45 WIB',
    ]);
    expect(content.preview).toContain('Nomor antrean Anda: *A-012*');
    expect(content.preview).toContain('STATUS');
    expect(content.preview).toContain('BATAL');
    expect(content.preview).not.toMatch(/https?:/);
  });

  it('uses the tenant greeting from branding and hides a hidden estimate', () => {
    const planned = buildNotification(
      ticketCreated({ estimated_serve_time: null }),
      { ...CONTEXT, greeting: 'Selamat datang di\nKlinik Sehat!' },
      'id',
    );
    const content = templateOf(planned);
    expect(content.parameters[1]).toBe('Selamat datang di Klinik Sehat!');
    expect(content.parameters[6]).toBe('kami kabari lagi saat giliran Anda mendekat');
    expect(content.preview).not.toContain('pukul');
  });

  it('skips a ticket without a WhatsApp number (staff input, FR-QUEUE-04)', () => {
    expect(buildNotification(ticketCreated({ customer_phone: null }), CONTEXT, 'id')).toBeNull();
  });

  it('queue.ticket.near_turn and queue.ticket.called (FR-NOTIF-03, FR-NOTIF-04)', () => {
    expect(templateOf(buildNotification(ticketNearTurn(), CONTEXT, 'id')).parameters).toEqual([
      'Budi Santoso',
      'Klinik Pratama Sehat',
      'A-012',
      'Poli Umum',
      '2',
      'kami kabari lagi saat giliran Anda mendekat',
    ]);
    const called = templateOf(buildNotification(ticketCalled(), CONTEXT, 'id'));
    expect(called.name).toBe('antre_ticket_called');
    expect(called.preview).toContain('nomor antrean Anda *A-012* sedang dipanggil di Loket 2');
    expect(templateOf(buildNotification(ticketCalled(true), CONTEXT, 'id')).parameters[1]).toBe(
      'panggilan ulang',
    );
  });

  it('booking events carry service, resource label, schedule, and DP', () => {
    const context = { ...CONTEXT, resourceLabel: 'Lapangan' };
    const held = templateOf(buildNotification(bookingHeld(), context, 'id'));
    expect(held.name).toBe('antre_booking_payment');
    expect(held.parameters).toEqual([
      'Siti Aminah',
      'Klinik Pratama Sehat',
      'Sewa Lapangan',
      'Lapangan',
      'Lapangan 1',
      'Selasa, 20 Oktober 2026 pukul 10.00 WIB',
      'Rp50.000',
      'PAY-ABC123',
      'pembayaran simulasi, tidak ada tagihan nyata',
      '17.05 WIB',
    ]);
    const linked = templateOf(
      buildNotification(bookingHeld(), context, 'id', {
        qrisSimulatorUrl: 'http://127.0.0.1:3300/qris',
      }),
    );
    expect(linked.parameters[8]).toBe('http://127.0.0.1:3300/qris/PAY-ABC123');
    expect(linked.preview).toContain('QRIS (simulasi): http://127.0.0.1:3300/qris/PAY-ABC123');

    const confirmed = templateOf(buildNotification(bookingConfirmed(), CONTEXT, 'id'));
    expect(confirmed.name).toBe('antre_booking_confirmed');
    expect(confirmed.parameters[3]).toBe('Tempat');
    expect(confirmed.parameters[6]).toBe('Rp50.000 (lunas)');
    expect(
      templateOf(buildNotification(bookingConfirmed(false), CONTEXT, 'id')).parameters[6],
    ).toBe('tidak ada');

    const expired = templateOf(buildNotification(bookingExpired(), CONTEXT, 'id'));
    expect(expired.parameters[4]).toBe('tidak ada pembayaran yang tercatat');
    expect(
      templateOf(buildNotification(bookingExpired('REFUND_PENDING'), CONTEXT, 'id')).parameters[4],
    ).toContain('dikembalikan');

    const reminder = templateOf(buildNotification(bookingReminder(), CONTEXT, 'id'));
    expect(reminder.name).toBe('antre_booking_reminder');
    expect(reminder.parameters[2]).toBe('10.00 WIB');
  });

  it('booking.reservation.cancelled: schedule and refund note for every cancellation (S09)', () => {
    const unpaid = buildNotification(bookingCancelled(), CONTEXT, 'id');
    expect(unpaid?.templateName).toBe('antre_booking_cancelled');
    expect(unpaid?.message.to).toBe('6289876543210');
    expect(templateOf(unpaid).parameters).toEqual([
      'Siti Aminah',
      'Klinik Pratama Sehat',
      'Sewa Lapangan',
      'Selasa, 20 Oktober 2026 pukul 10.00 WIB',
      'tidak ada pembayaran yang tercatat',
    ]);
    const refunded = templateOf(
      buildNotification(bookingCancelled('REFUND_PENDING'), CONTEXT, 'id'),
    );
    expect(refunded.parameters[4]).toBe('DP yang sudah dibayar akan dikembalikan oleh petugas');
    expect(refunded.preview).toContain('telah dibatalkan');
  });

  it('billing events go to the admin number of the tenant', () => {
    const warning = buildNotification(quotaWarning(), CONTEXT, 'id');
    expect(warning?.message.to).toBe('6281111111111');
    expect(templateOf(warning).parameters).toEqual([
      'Klinik Pratama Sehat',
      'Cabang Pusat',
      'Oktober 2026',
      '80',
      '100',
    ]);
    expect(templateOf(buildNotification(quotaExceeded(), CONTEXT, 'id')).name).toBe(
      'antre_quota_exceeded',
    );
    const activated = templateOf(buildNotification(subscriptionActivated(), CONTEXT, 'id'));
    expect(activated.parameters.slice(2)).toEqual([
      'Minggu, 18 Oktober 2026',
      'Rabu, 18 November 2026',
      'SUB-XYZ789',
    ]);
  });

  it('wa.reply.requested passes the conversation message through without a template', () => {
    const event = replyRequested();
    const planned = buildNotification(event, fallbackContext(event), 'id');
    expect(planned?.templateName).toBeNull();
    expect(planned?.message).toEqual({ to: event.data.to, content: event.data.message });
  });

  it('falls back to the envelope when the location cannot be read', () => {
    expect(fallbackContext(ticketCreated())).toEqual({
      tenantName: TENANT.name,
      greeting: null,
      resourceLabel: null,
      locationName: 'pusat',
      timeZone: 'Asia/Jakarta',
    });
  });
});
