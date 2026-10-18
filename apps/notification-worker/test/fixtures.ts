// Event fixtures shared by the unit and integration tests. Each call creates a new event id.
import { createEvent, type EventData, type EventEnvelope } from '@antre/event-contracts';

export const TENANT = { id: 'c38a2e12-88f5-4f32-843e-90cb6d88f9a1', name: 'Klinik Pratama Sehat' };
export const LOCATION = { id: '5b1f0c7e-2d4a-4e6b-9a51-7c3f8e2d1a90', code: 'pusat' };
export const PHONE = '6281234567890';

type Scope = { tenant: { id: string; name: string }; location: { id: string; code: string } };
const DEFAULT_SCOPE: Scope = { tenant: TENANT, location: LOCATION };

export function ticketCreated(
  overrides: Partial<EventData<'queue.ticket.created'>> = {},
  scope: Scope = DEFAULT_SCOPE,
): EventEnvelope<'queue.ticket.created'> {
  return createEvent('queue.ticket.created', {
    ...scope,
    data: {
      ticket_id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
      ticket_number: 'A-012',
      customer_name: 'Budi Santoso',
      customer_phone: PHONE,
      status: 'WAITING',
      channel: 'WHATSAPP',
      service_name: 'Poli Umum',
      people_ahead: 4,
      estimated_serve_time: '2026-10-20T03:45:00Z',
      ...overrides,
    },
  });
}

export function ticketNearTurn(): EventEnvelope<'queue.ticket.near_turn'> {
  return createEvent('queue.ticket.near_turn', {
    ...DEFAULT_SCOPE,
    data: {
      ticket_id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
      ticket_number: 'A-012',
      customer_name: 'Budi Santoso',
      customer_phone: PHONE,
      status: 'WAITING',
      service_name: 'Poli Umum',
      people_ahead: 2,
      estimated_serve_time: null,
    },
  });
}

export function ticketCalled(isRecall = false): EventEnvelope<'queue.ticket.called'> {
  return createEvent('queue.ticket.called', {
    ...DEFAULT_SCOPE,
    data: {
      ticket_id: '9e2c4b1a-6f3d-4c8e-b2a7-1d5f9e0c3b42',
      ticket_number: 'A-012',
      customer_name: 'Budi Santoso',
      customer_phone: PHONE,
      status: 'CALLED',
      is_recall: isRecall,
      resource_name: 'Loket 2',
      called_at: '2026-10-20T03:45:00Z',
    },
  });
}

const booking = {
  booking_id: '1f8e3c2a-5b4d-4e6f-8a9b-0c1d2e3f4a5b',
  customer_name: 'Siti Aminah',
  customer_phone: '6289876543210',
  service_name: 'Sewa Lapangan',
  resource_name: 'Lapangan 1',
  start_time: '2026-10-20T03:00:00Z',
  end_time: '2026-10-20T04:00:00Z',
};

export function bookingHeld(): EventEnvelope<'booking.reservation.held'> {
  return createEvent('booking.reservation.held', {
    ...DEFAULT_SCOPE,
    data: {
      ...booking,
      status: 'PENDING_PAYMENT',
      payment_status: 'UNPAID',
      dp_amount: 50000,
      payment_ref: 'PAY-ABC123',
      hold_expires_at: '2026-10-19T10:05:00Z',
    },
  });
}

export function bookingConfirmed(paid = true): EventEnvelope<'booking.reservation.confirmed'> {
  return createEvent('booking.reservation.confirmed', {
    ...DEFAULT_SCOPE,
    data: paid
      ? { ...booking, status: 'CONFIRMED', payment_status: 'PAID', dp_amount: 50000 }
      : { ...booking, status: 'CONFIRMED', payment_status: 'NOT_REQUIRED', dp_amount: null },
  });
}

export function bookingExpired(
  paymentStatus: 'UNPAID' | 'REFUND_PENDING' = 'UNPAID',
): EventEnvelope<'booking.reservation.expired'> {
  return createEvent('booking.reservation.expired', {
    ...DEFAULT_SCOPE,
    data: { ...booking, status: 'EXPIRED', payment_status: paymentStatus },
  });
}

export function bookingCancelled(
  paymentStatus: 'UNPAID' | 'NOT_REQUIRED' | 'REFUND_PENDING' = 'UNPAID',
): EventEnvelope<'booking.reservation.cancelled'> {
  return createEvent('booking.reservation.cancelled', {
    ...DEFAULT_SCOPE,
    data: { ...booking, status: 'CANCELLED', payment_status: paymentStatus },
  });
}

export function bookingReminder(): EventEnvelope<'booking.reservation.reminder_due'> {
  return createEvent('booking.reservation.reminder_due', {
    ...DEFAULT_SCOPE,
    data: { ...booking, status: 'CONFIRMED' },
  });
}

export function quotaWarning(): EventEnvelope<'billing.quota.warning'> {
  return createEvent('billing.quota.warning', {
    ...DEFAULT_SCOPE,
    data: {
      admin_wa_phone: '6281111111111',
      plan_code: 'FREE',
      period_month: '2026-10-01',
      ticket_count: 80,
      monthly_ticket_quota: 100,
    },
  });
}

export function quotaExceeded(): EventEnvelope<'billing.quota.exceeded'> {
  return createEvent('billing.quota.exceeded', {
    ...DEFAULT_SCOPE,
    data: {
      admin_wa_phone: '6281111111111',
      plan_code: 'FREE',
      period_month: '2026-10-01',
      ticket_count: 100,
      monthly_ticket_quota: 100,
    },
  });
}

export function subscriptionActivated(): EventEnvelope<'billing.subscription.activated'> {
  return createEvent('billing.subscription.activated', {
    ...DEFAULT_SCOPE,
    data: {
      admin_wa_phone: '6281111111111',
      subscription_id: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
      plan_code: 'PAID_LOCATION',
      payment_ref: 'SUB-XYZ789',
      current_period_start: '2026-10-18T05:00:00Z',
      current_period_end: '2026-11-18T05:00:00Z',
    },
  });
}

export function replyRequested(
  tenant: Scope['tenant'] | null = null,
): EventEnvelope<'wa.reply.requested'> {
  return createEvent('wa.reply.requested', {
    tenant,
    location: null,
    data: {
      to: PHONE,
      message: {
        kind: 'buttons',
        body: 'Pilih menu:\n1. Ambil Antrean\n2. Cek Status',
        buttons: [
          { id: 'menu.queue', title: 'Ambil Antrean' },
          { id: 'menu.status', title: 'Cek Status' },
        ],
      },
    },
  });
}

export function statusReceived(
  wamid: string,
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
): EventEnvelope<'wa.status.received'> {
  return createEvent('wa.status.received', {
    tenant: null,
    location: null,
    data: { wamid, status, status_at: '2026-10-20T03:46:00Z', recipient: PHONE },
  });
}
