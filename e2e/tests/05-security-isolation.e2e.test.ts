// Journey (e): tenant isolation and the doors that must stay shut: another tenant's token, forged
// tokens, unsigned webhooks, and the internal API.
import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, signature } from '../src/api.js';
import { openStream, update, type SseConnection } from '../src/sse.js';
import { stack } from '../src/stack.js';
import { provisionTenant, type TenantFixture } from '../src/tenant.js';

const b64 = (value: object | string) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function forge(payload: object, key: string): string {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  return `${header}.${body}.${createHmac('sha256', key).update(`${header}.${body}`).digest('base64url')}`;
}

const DENIED = [401, 403, 404];

describe('tenant isolation and closed doors', () => {
  let one: TenantFixture;
  let two: TenantFixture;
  let oneTicket: { id: string; ticket_number: string };
  let streamTwo: SseConnection;
  let streamOne: SseConnection;
  const foreign: SseConnection[] = [];

  beforeAll(async () => {
    [one, two] = await Promise.all([
      provisionTenant({ prefix: 'iso-a' }),
      provisionTenant({ prefix: 'iso-b' }),
    ]);
    streamOne = await openStream(stack().realtimeUrl, one.locationId, one.caller.token);
    streamTwo = await openStream(stack().realtimeUrl, two.locationId, two.caller.token);
    await streamOne.waitFor((m) => m.event === 'snapshot', 'snapshot one');
    await streamTwo.waitFor((m) => m.event === 'snapshot', 'snapshot two');
    // Tenant two (and a kiosk of tenant one) try to listen to the other tenant's location.
    for (const [locationId, token] of [
      [one.locationId, two.owner.token],
      [one.locationId, two.caller.token],
      [one.locationId, two.kioskToken],
      [two.locationId, one.kioskToken],
    ] as const) {
      foreign.push(await openStream(stack().realtimeUrl, locationId, token));
    }

    const created = await api('POST', '/api/v1/queues/tickets', {
      token: one.cashier.token,
      body: {
        location_id: one.locationId,
        service_id: one.freeServiceId,
        customer_name: 'Rahasia Satu',
        customer_phone: '6281999000111',
      },
    });
    expect(created.status).toBe(201);
    oneTicket = { id: created.body.id, ticket_number: created.body.ticket_number };
  });

  afterAll(() => {
    streamOne?.close();
    streamTwo?.close();
    for (const stream of foreign) stream.close();
  });

  describe('API: the second tenant sees nothing of the first', () => {
    it('reads of tenant one resources are denied or empty', async () => {
      const token = two.owner.token;
      const tickets = await api('GET', `/api/v1/queues/tickets?location_id=${one.locationId}`, {
        token,
      });
      if (tickets.status === 200) expect(tickets.body.tickets).toEqual([]);
      else expect(DENIED).toContain(tickets.status);

      for (const path of [
        `/api/v1/catalog/resources?location_id=${one.locationId}`,
        `/api/v1/catalog/locations/${one.locationId}/operating-hours`,
        `/api/v1/billing/locations/${one.locationId}/subscription`,
        `/api/v1/bookings?location_id=${one.locationId}&date=2030-01-01`,
      ]) {
        const response = await api('GET', path, { token });
        // Denied, or answered from the caller's own (empty) view: never tenant one's data.
        if (response.status !== 200) expect(DENIED, path).toContain(response.status);
        const text = JSON.stringify(response.body);
        for (const id of [...one.resourceIds, one.freeServiceId, one.dpServiceId]) {
          expect(text).not.toContain(id);
        }
      }
      // The user list is the second tenant's own.
      const users = await api('GET', '/api/v1/users', { token });
      expect(users.status).toBe(200);
      expect(JSON.stringify(users.body)).not.toContain(one.owner.email);
    });

    it('writes against tenant one are refused and change nothing', async () => {
      const token = two.owner.token;
      const action = await api('POST', `/api/v1/queues/tickets/${oneTicket.id}/actions`, {
        token,
        body: { action: 'SERVE' },
      });
      expect(DENIED).toContain(action.status);
      const intoOne = await api('POST', '/api/v1/queues/tickets', {
        token,
        body: { location_id: one.locationId, service_id: one.freeServiceId, customer_name: 'X' },
      });
      expect(DENIED.concat([400])).toContain(intoOne.status);
      const withForeignService = await api('POST', '/api/v1/queues/tickets', {
        token,
        body: { location_id: two.locationId, service_id: one.freeServiceId, customer_name: 'X' },
      });
      expect(DENIED.concat([400])).toContain(withForeignService.status);
      const rename = await api('PATCH', `/api/v1/catalog/services/${one.freeServiceId}`, {
        token,
        body: { name: 'dibajak' },
      });
      expect(DENIED).toContain(rename.status);
      const kiosk = await api('POST', `/api/v1/locations/${one.locationId}/kiosk-tokens`, {
        token,
      });
      expect(DENIED).toContain(kiosk.status);

      // Tenant one's ticket is untouched.
      const still = await api('GET', `/api/v1/queues/tickets?location_id=${one.locationId}`, {
        token: one.owner.token,
      });
      expect(still.body.tickets.find((t: { id: string }) => t.id === oneTicket.id)?.status).toBe(
        'WAITING',
      );
      const services = await api('GET', '/api/v1/catalog/services', { token: one.owner.token });
      expect(JSON.stringify(services.body)).not.toContain('dibajak');
    });

    it('staff tokens of one tenant cannot be used for the other (and tenant two staff are limited)', async () => {
      const response = await api('GET', `/api/v1/queues/tickets?location_id=${one.locationId}`, {
        token: two.caller.token,
      });
      if (response.status === 200) expect(response.body.tickets).toEqual([]);
      else expect(DENIED).toContain(response.status);
      const platform = await api('GET', '/api/v1/admin/tenants', { token: two.owner.token });
      expect(DENIED).toContain(platform.status);
    });
  });

  describe('realtime: no event crosses the tenant line', () => {
    it('tickets reach only their own tenant, including through streams opened on a foreign location', async () => {
      await streamOne.waitFor(update('queue.ticket.created', oneTicket.ticket_number), 'own event');

      const own = await api('POST', '/api/v1/queues/tickets', {
        token: two.cashier.token,
        body: { location_id: two.locationId, service_id: two.freeServiceId, customer_name: 'Dua' },
      });
      expect(own.status).toBe(201);
      await streamTwo.waitFor(update('queue.ticket.created', 'A-001'), 'tenant two own event');
      // A ticket made after the event of two, then another event of one: ordering control.
      await api('POST', '/api/v1/queues/tickets', {
        token: one.cashier.token,
        body: {
          location_id: one.locationId,
          service_id: one.freeServiceId,
          customer_name: 'Satu b',
        },
      });
      await streamOne.waitFor(update('queue.ticket.created', 'A-002'), 'second event of one');

      const rawTwo = streamTwo.raw();
      expect(rawTwo).not.toContain(oneTicket.id);
      expect(rawTwo).not.toContain(one.locationId);
      expect(rawTwo).not.toContain('Rahasia Satu');
      expect(rawTwo).not.toContain('6281999000111');
      expect(streamTwo.messages.filter((m) => m.event === 'update')).toHaveLength(1);
      expect(streamOne.raw()).not.toContain(own.body.id);

      // Streams opened on the other tenant's location are refused, or open but silent: the
      // channel key carries the tenant of the token, so they never receive a foreign event.
      for (const stream of foreign) {
        if (stream.status !== 200) expect(DENIED).toContain(stream.status);
        const raw = stream.raw();
        for (const secret of [oneTicket.id, own.body.id, 'Rahasia Satu', '6281999000111', 'Dua']) {
          expect(raw).not.toContain(secret);
        }
        expect(stream.messages.filter((m) => m.event === 'update')).toEqual([]);
      }
    });
  });

  describe('forged and missing credentials', () => {
    it('JWTs that are not ours are 401 on the API and on the stream', async () => {
      const [, payloadPart, signaturePart] = one.owner.token.split('.');
      const claims = JSON.parse(Buffer.from(payloadPart!, 'base64url').toString()) as object;
      const forgeries: Record<string, string> = {
        'alg none': `${b64({ alg: 'none', typ: 'JWT' })}.${payloadPart}.`,
        'wrong secret': forge(claims, 'not-the-secret-not-the-secret-not-the-secret'),
        'tampered tenant': `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, tenant_id: two.tenantId })}.${signaturePart}`,
        expired: forge({ ...claims, exp: 1 }, 'not-the-secret-not-the-secret-not-the-secret'),
        garbage: 'abc.def.ghi',
      };
      for (const [name, token] of Object.entries(forgeries)) {
        const response = await api('GET', '/api/v1/catalog/services', { token });
        expect(response.status, name).toBe(401);
        const stream = await openStream(stack().realtimeUrl, one.locationId, token);
        expect(stream.status, `stream ${name}`).toBe(401);
        stream.close();
      }
      expect((await api('GET', '/api/v1/catalog/services')).status).toBe(401);
      const noToken = await openStream(stack().realtimeUrl, one.locationId, '');
      expect(noToken.status).toBe(401);
      noToken.close();
    });

    it('the WhatsApp webhook refuses missing, wrong, and body-mismatching signatures', async () => {
      const wa = { base: stack().waUrl };
      const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
      const secret = stack().secrets.waAppSecret;
      const post = (body: string, headers: Record<string, string>) =>
        api('POST', '/api/v1/channels/wa/webhook', { ...wa, body, headers });

      expect((await post(raw, {})).status).toBe(401);
      expect(
        (await post(raw, { 'x-hub-signature-256': signature(raw, 'wrong-secret') })).status,
      ).toBe(401);
      expect(
        (await post(raw, { 'x-hub-signature-256': signature('{"other":1}', secret) })).status,
      ).toBe(401);
      // No "sha256=" prefix.
      expect(
        (
          await post(raw, {
            'x-hub-signature-256': createHmac('sha256', secret).update(raw).digest('hex'),
          })
        ).status,
      ).toBe(401);
      // The right signature is accepted (an empty event list is fine).
      expect((await post(raw, { 'x-hub-signature-256': signature(raw, secret) })).status).toBe(200);
    });

    it('the webhook subscription handshake needs the verify token', async () => {
      const challenge = '1158201444';
      const url = (token: string) =>
        `/api/v1/channels/wa/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${challenge}`;
      const good = await api('GET', url(stack().secrets.waVerifyToken), { base: stack().waUrl });
      expect(good.status).toBe(200);
      expect(String(good.body)).toBe(challenge);
      const bad = await api('GET', url('nope'), { base: stack().waUrl });
      expect(bad.status).toBe(403);
    });

    it('the payment callbacks refuse a missing or foreign signature', async () => {
      for (const path of ['/api/v1/payments/qris/callback', '/api/v1/billing/payments/callback']) {
        const body = JSON.stringify({
          payment_ref: 'pay-x',
          tenant_id: one.tenantId,
          target_id: one.locationId,
          amount: 1,
          status: 'PAID',
        });
        expect((await api('POST', path, { body })).status).toBe(401);
        const foreign = await api('POST', path, {
          body,
          headers: { 'x-antre-signature': signature(body, 'c'.repeat(48)) },
        });
        expect(foreign.status).toBe(401);
      }
    });
  });

  describe('the internal API is for services only', () => {
    it('refuses a user token, a missing token, and a wrong token', async () => {
      const path = '/internal/v1/queues/tickets/active';
      for (const token of [one.owner.token, one.caller.token, 'z'.repeat(48), undefined]) {
        const response = await api('GET', path, {
          token,
          headers: { 'x-antre-tenant-id': one.tenantId },
        });
        expect([401, 403]).toContain(response.status);
      }
    });

    it('is not offered by the WA Channel or the realtime gateway either', async () => {
      for (const base of [stack().waUrl, stack().realtimeUrl]) {
        const response = await api('GET', '/internal/v1/queues/tickets/active', {
          base,
          token: stack().secrets.serviceToken,
          headers: { 'x-antre-tenant-id': one.tenantId },
        });
        expect(response.status).toBe(404);
      }
    });

    it('public customers never need it: a WhatsApp customer gets a ticket without any token', async () => {
      // Covered end to end in the walk-in journey; here only the negative: the public API has no
      // route that accepts the service token in place of a user.
      const response = await api('GET', '/api/v1/catalog/services', {
        token: stack().secrets.serviceToken,
      });
      expect(response.status).toBe(401);
    });
  });
});
