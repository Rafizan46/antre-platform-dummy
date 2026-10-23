// Journey (d): a FREE location uses up its monthly ticket quota, customers are turned away
// politely, the owner upgrades through a (signed) payment, and tickets flow again.
import { beforeAll, describe, expect, it } from 'vitest';

import { api, internal, paymentCallback } from '../src/api.js';
import { eventually } from '../src/stack.js';
import { provisionTenant, type TenantFixture } from '../src/tenant.js';
import { WaCustomer } from '../src/wa.js';

const FREE_QUOTA = 100;

describe('quota and subscription', () => {
  let tenant: TenantFixture;
  const admin = (): WaCustomer => new WaCustomer(tenant.adminPhone);
  let adminLine: WaCustomer;
  let checkout: { payment: { payment_ref: string; target_id: string; amount: number } };

  const createTicket = (name: string, phone: string) =>
    internal('POST', '/queues/tickets', tenant.tenantId, {
      location_id: tenant.locationId,
      service_id: tenant.freeServiceId,
      customer_name: name,
      customer_phone: phone,
    });
  const overview = () =>
    api('GET', `/api/v1/billing/locations/${tenant.locationId}/subscription`, {
      token: tenant.owner.token,
    });

  beforeAll(async () => {
    tenant = await provisionTenant({ prefix: 'quota' });
    adminLine = admin();
  });

  it('a new location starts on the FREE plan with the quota unused', async () => {
    const response = await overview();
    expect(response.status).toBe(200);
    expect(response.body.subscription.plan_code).toBe('FREE');
    expect(response.body.usage.ticket_count).toBe(0);
    expect(response.body.usage.monthly_ticket_quota).toBe(FREE_QUOTA);
  });

  it('accepts exactly the quota worth of tickets, then answers 402', async () => {
    // Through the internal endpoint with the service token, the same path the WA Channel uses.
    for (let first = 0; first < FREE_QUOTA; first += 10) {
      const batch = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          createTicket(`Pelanggan ${first + i}`, `62899${String(first + i).padStart(7, '0')}`),
        ),
      );
      for (const response of batch) expect(response.status).toBe(201);
    }
    const usage = await overview();
    expect(usage.body.usage.ticket_count).toBe(FREE_QUOTA);
    expect(usage.body.usage.exhausted).toBe(true);

    const rejected = await createTicket('Pelanggan 101', '628990000101');
    expect(rejected.status).toBe(402);
    expect(rejected.body.error.code).toBe('QUOTA_EXCEEDED');
    // The staff screen is turned away too, with the same code.
    const staff = await api('POST', '/api/v1/queues/tickets', {
      token: tenant.cashier.token,
      body: {
        location_id: tenant.locationId,
        service_id: tenant.freeServiceId,
        customer_name: 'X',
      },
    });
    expect(staff.status).toBe(402);
  });

  it('a WhatsApp customer gets a polite message and the admin is told', async () => {
    const customer = new WaCustomer();
    await customer.ask(`ANTRE ${tenant.slug} ${tenant.locationCode}`);
    await customer.ask('1');
    const refusal = await customer.ask('1');
    expect(refusal.text).toMatch(/tidak tersedia/i);
    expect(refusal.text).toMatch(/Maaf.*petugas/s);

    const notice = await adminLine.nextReply(
      'quota exceeded notice',
      (m) => m.template === 'antre_quota_exceeded',
    );
    expect(notice.text).toContain('Upgrade');
  });

  it('the owner starts a checkout; only the owner may', async () => {
    const denied = await api(
      'POST',
      `/api/v1/billing/locations/${tenant.locationId}/subscription/checkout`,
      { token: tenant.caller.token },
    );
    expect(denied.status).toBe(403);

    const response = await api(
      'POST',
      `/api/v1/billing/locations/${tenant.locationId}/subscription/checkout`,
      { token: tenant.owner.token },
    );
    expect(response.status).toBe(201);
    checkout = response.body;
    expect(checkout.payment.payment_ref).toMatch(/^sub-/);
  });

  it('an unsigned or wrongly signed callback does not activate anything', async () => {
    const body = {
      payment_ref: checkout.payment.payment_ref,
      tenant_id: tenant.tenantId,
      target_id: checkout.payment.target_id,
      amount: checkout.payment.amount,
      status: 'PAID' as const,
    };
    const forged = await paymentCallback('/api/v1/billing/payments/callback', body, 'b'.repeat(48));
    expect(forged.status).toBe(401);
    const unsigned = await api('POST', '/api/v1/billing/payments/callback', { body });
    expect(unsigned.status).toBe(401);
    expect((await overview()).body.subscription.status).not.toBe('ACTIVE');
  });

  it('the signed callback activates the subscription and tickets flow again', async () => {
    const paid = await paymentCallback('/api/v1/billing/payments/callback', {
      payment_ref: checkout.payment.payment_ref,
      tenant_id: tenant.tenantId,
      target_id: checkout.payment.target_id,
      amount: checkout.payment.amount,
      status: 'PAID',
    });
    expect(paid.status).toBe(200);

    await eventually('subscription ACTIVE', async () => {
      const response = await overview();
      return response.body.subscription.status === 'ACTIVE';
    });
    const after = await overview();
    expect(after.body.subscription.plan_code).not.toBe('FREE');

    const notice = await adminLine.nextReply(
      'subscription activated notice',
      (m) => m.template === 'antre_subscription_activated',
    );
    expect(notice.text).toContain('aktif');

    const ticket = await createTicket('Pelanggan 101', '628990000101');
    expect(ticket.status).toBe(201);
    const walkIn = new WaCustomer();
    await walkIn.ask(`ANTRE ${tenant.slug} ${tenant.locationCode}`);
    await walkIn.ask('1');
    const created = await walkIn.ask('1');
    expect(created.template).toBe('antre_ticket_created');
  });
});
