import { createEvent } from '@antre/event-contracts';
import { describe, expect, it } from 'vitest';

import {
  compareStreamIds,
  decodeRealtimeMessage,
  encodeKioskRevoked,
  kioskRevokedKey,
  realtimeChannel,
  realtimeLogKey,
  toRealtimeUpdate,
} from './realtime.js';

const tenant = { id: 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1', name: 'Klinik' };
const location = { id: '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90', code: 'pusat' };

describe('toRealtimeUpdate', () => {
  it('keeps the display fields of queue.ticket.called and drops the customer data', () => {
    const event = createEvent(
      'queue.ticket.called',
      {
        tenant,
        location,
        data: {
          ticket_id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
          ticket_number: 'A-012',
          customer_name: 'Budi Santoso',
          customer_phone: '6281234567890',
          status: 'CALLED',
          is_recall: false,
          resource_name: 'Loket 1',
          called_at: '2026-10-18T03:00:00Z',
        },
      },
      { now: new Date('2026-10-18T03:00:00Z'), eventId: 'evt-11111111' },
    );

    const update = toRealtimeUpdate(event);

    expect(update).toEqual({
      type: 'queue.ticket.called',
      event_id: 'evt-11111111',
      at: '2026-10-18T03:00:00Z',
      location_id: location.id,
      status: 'CALLED',
      ticket_id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
      ticket_number: 'A-012',
      is_recall: false,
      resource_name: 'Loket 1',
    });
    const json = JSON.stringify(update);
    expect(json).not.toContain('6281234567890');
    expect(json).not.toContain('Budi');
  });

  it('drops the payment data of booking.reservation.held', () => {
    const event = createEvent('booking.reservation.held', {
      tenant,
      location,
      data: {
        booking_id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
        customer_name: 'Budi',
        customer_phone: '6281234567890',
        service_name: 'Konsultasi',
        resource_name: 'Ruang A',
        start_time: '2026-10-18T03:00:00Z',
        end_time: '2026-10-18T03:30:00Z',
        status: 'PENDING_PAYMENT',
        payment_status: 'UNPAID',
        dp_amount: 50000,
        payment_ref: 'PAY-123',
        hold_expires_at: '2026-10-18T02:05:00Z',
      },
    });

    const update = toRealtimeUpdate(event)!;

    expect(Object.keys(update).sort()).toEqual(
      [
        'at',
        'booking_id',
        'end_time',
        'event_id',
        'location_id',
        'resource_name',
        'service_name',
        'start_time',
        'status',
        'type',
      ].sort(),
    );
  });

  it('ignores events without a realtime view', () => {
    const event = createEvent('wa.reply.requested', {
      tenant: null,
      location: null,
      data: { to: '6281234567890', message: { kind: 'text', body: 'hai' } },
    });
    expect(toRealtimeUpdate(event)).toBeNull();
  });
});

describe('realtime messages', () => {
  it('names the keys per tenant and location', () => {
    expect(realtimeChannel('t', 'l')).toBe('rt:t:l');
    expect(realtimeLogKey('t', 'l')).toBe('rt:log:t:l');
    expect(kioskRevokedKey('t', 'l')).toBe('rt:kiosk-revoked:t:l');
  });

  it('decodes updates and control messages and rejects anything else', () => {
    const update = { type: 'queue.ticket.cancelled', status: 'CANCELLED' };
    expect(decodeRealtimeMessage(JSON.stringify({ id: '1-0', update }))).toEqual({
      kind: 'update',
      id: '1-0',
      update,
    });
    expect(decodeRealtimeMessage(encodeKioskRevoked(42))).toEqual({
      kind: 'kiosk_revoked',
      revokedAt: 42,
    });
    expect(decodeRealtimeMessage('not json')).toBeNull();
    expect(decodeRealtimeMessage(JSON.stringify({ id: 'x', update }))).toBeNull();
    expect(
      decodeRealtimeMessage(JSON.stringify({ id: '1-0', update: { type: 'wa.reply.requested' } })),
    ).toBeNull();
  });

  it('orders stream ids numerically', () => {
    expect(compareStreamIds('10-0', '9-5')).toBe(1);
    expect(compareStreamIds('9-5', '9-10')).toBe(-1);
    expect(compareStreamIds('9-5', '9-5')).toBe(0);
  });
});
