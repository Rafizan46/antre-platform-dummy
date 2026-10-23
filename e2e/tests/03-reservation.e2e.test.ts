// Journey (c): a customer reserves a slot of a service with a down payment on WhatsApp, pays with
// QRIS (signed provider callback), and the slot is theirs; nobody else can take it; cancelling
// frees it.
import { beforeAll, describe, expect, it } from 'vitest';

import { api, internal, paymentCallback } from '../src/api.js';
import { eventually } from '../src/stack.js';
import { provisionTenant, type TenantFixture } from '../src/tenant.js';
import { WaCustomer } from '../src/wa.js';

interface CalendarBooking {
  id: string;
  customer_phone: string;
  status: string;
  payment_status: string;
  payment_ref: string | null;
  start_time: string;
  dp_amount: number;
}

/** Tomorrow's date in the tenant time zone (WIB), the second option of the date menu. */
function tomorrowInJakarta(): string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' });
  return format.format(new Date(Date.now() + 24 * 3600 * 1000));
}

describe('reservation with a down payment', () => {
  let tenant: TenantFixture;
  const customerB = new WaCustomer();
  const customerC = new WaCustomer();
  let booking: CalendarBooking;

  const keyword = () => `ANTRE ${tenant.slug} ${tenant.locationCode}`;

  const bookingsOf = async (): Promise<CalendarBooking[]> => {
    const response = await api(
      'GET',
      `/api/v1/bookings?location_id=${tenant.locationId}&date=${tomorrowInJakarta()}`,
      { token: tenant.cashier.token },
    );
    expect(response.status).toBe(200);
    return response.body.slots.flatMap(
      (slot: { resources: { booking: CalendarBooking | null }[] }) =>
        slot.resources
          .map((resource) => resource.booking)
          .filter((b): b is CalendarBooking => b !== null),
    );
  };
  const bookingOf = async (phone: string) =>
    (await bookingsOf()).find((candidate) => candidate.customer_phone === phone);

  /** Walks the menu to the slot list of tomorrow for the service with a down payment. */
  const reachSlotList = async (customer: WaCustomer) => {
    await customer.ask(keyword());
    await customer.ask('2'); // Reservasi
    const dates = await customer.ask('2'); // Perawatan (DP)
    expect(dates.text).toContain('Pilih tanggal');
    return customer.ask('2'); // tomorrow
  };

  beforeAll(async () => {
    // One resource, so a slot taken once is really gone.
    tenant = await provisionTenant({ prefix: 'reserve', resources: 1 });
  });

  it('customer B reserves tomorrow 00.00 and receives the payment request (hold)', async () => {
    const slots = await reachSlotList(customerB);
    expect(slots.text).toContain('Pilih jam');
    expect(slots.text).toContain('00.00-00.30 WIB');

    const payment = await customerB.ask('1');
    expect(payment.template).toBe('antre_booking_payment');
    expect(payment.text).toContain('Rp50.000');

    booking = (await bookingOf(customerB.phone))!;
    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.payment_status).toBe('UNPAID');
    expect(booking.payment_ref).toMatch(/^pay-/);
    expect(payment.text).toContain(booking.payment_ref!);
  });

  it('customer C cannot take the held slot, by menu or by the internal hold endpoint', async () => {
    const slots = await reachSlotList(customerC);
    expect(slots.text).not.toContain('00.00-00.30 WIB');
    expect(slots.text).toContain('00.30-01.00 WIB');

    const direct = await internal('POST', '/bookings/holds', tenant.tenantId, {
      location_id: tenant.locationId,
      service_id: tenant.dpServiceId,
      slot_start: booking.start_time,
      customer_name: 'Pelanggan C',
      customer_phone: customerC.phone,
    });
    expect(direct.status).toBe(409);
    // C never got a booking on B's slot.
    expect((await bookingOf(customerC.phone))?.start_time ?? null).not.toBe(booking.start_time);
  });

  it('a callback with a forged callback does not confirm the booking', async () => {
    const body = {
      payment_ref: booking.payment_ref!,
      tenant_id: tenant.tenantId,
      target_id: booking.id,
      amount: tenant.dpAmount,
      status: 'PAID' as const,
    };
    const forged = await paymentCallback('/api/v1/payments/qris/callback', body, 'a'.repeat(48));
    expect(forged.status).toBe(401);
    expect((await bookingOf(customerB.phone))?.status).toBe('PENDING_PAYMENT');
  });

  it('the signed QRIS callback confirms the booking and B gets the confirmation', async () => {
    const paid = await paymentCallback('/api/v1/payments/qris/callback', {
      payment_ref: booking.payment_ref!,
      tenant_id: tenant.tenantId,
      target_id: booking.id,
      amount: tenant.dpAmount,
      status: 'PAID',
    });
    expect(paid.status).toBe(200);

    const confirmation = await customerB.nextReply(
      'booking confirmation',
      (m) => m.template === 'antre_booking_confirmed',
    );
    expect(confirmation.text).toMatch(/dikonfirmasi|terkonfirmasi/i);

    const confirmed = (await bookingOf(customerB.phone))!;
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.payment_status).toBe('PAID');

    // The provider repeating the callback changes nothing.
    const repeat = await paymentCallback('/api/v1/payments/qris/callback', {
      payment_ref: booking.payment_ref!,
      tenant_id: tenant.tenantId,
      target_id: booking.id,
      amount: tenant.dpAmount,
      status: 'PAID',
    });
    expect(repeat.status).toBe(200);
  });

  it('the confirmed slot stays taken for everyone', async () => {
    const direct = await internal('POST', '/bookings/holds', tenant.tenantId, {
      location_id: tenant.locationId,
      service_id: tenant.dpServiceId,
      slot_start: booking.start_time,
      customer_name: 'Pelanggan C',
      customer_phone: customerC.phone,
    });
    expect(direct.status).toBe(409);
  });

  it('B cancels the booking on WhatsApp and the slot is free again', async () => {
    customerB.drain();
    // One cancellable item: BATAL cancels it directly; the confirmation is the cancelled template.
    expect((await customerB.send('BATAL')).status).toBe(200);
    const cancelled = await customerB.nextReply(
      'booking cancelled',
      (m) => m.template === 'antre_booking_cancelled',
    );
    expect(cancelled.text).toContain('Perawatan');

    // A cancelled booking leaves the calendar.
    await eventually(
      'B booking gone from the calendar',
      async () => (await bookingOf(customerB.phone)) === undefined,
    );

    const retry = await internal('POST', '/bookings/holds', tenant.tenantId, {
      location_id: tenant.locationId,
      service_id: tenant.dpServiceId,
      slot_start: booking.start_time,
      customer_name: 'Pelanggan C',
      customer_phone: customerC.phone,
    });
    expect(retry.status).toBe(201);
  });

  it('a payment of the wrong amount cancels the booking and tells the customer about the refund', async () => {
    const customerD = new WaCustomer();
    await reachSlotList(customerD);
    await customerD.ask('1');
    const held = (await bookingOf(customerD.phone))!;
    expect(held.status).toBe('PENDING_PAYMENT');

    const wrong = await paymentCallback('/api/v1/payments/qris/callback', {
      payment_ref: held.payment_ref!,
      tenant_id: tenant.tenantId,
      target_id: held.id,
      amount: tenant.dpAmount - 1,
      status: 'PAID',
    });
    expect(wrong.status).toBe(409);
    const notice = await customerD.nextReply(
      'booking cancelled',
      (m) => m.template === 'antre_booking_cancelled',
    );
    expect(notice.text).toMatch(/dikembalikan/i);
    expect(await bookingOf(customerD.phone)).toBeUndefined();
  });
});
