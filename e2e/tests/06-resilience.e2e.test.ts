// Journey (f): infrastructure failures that must not lose tickets or take services down.
//  - RabbitMQ: the harness runs the services against a TCP proxy in front of the broker, and the
//    test cuts and restores the proxy. The shared broker itself is never stopped, so this is safe
//    next to a dev stack and in CI.
//  - PostgreSQL: pg_terminate_backend on the E2E database's application connections (the
//    regression of BUG-1: an idle pooled connection killed by the server crashed core-services).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api } from '../src/api.js';
import { eventually, stack } from '../src/stack.js';
import { provisionTenant, type TenantFixture } from '../src/tenant.js';
import { WaCustomer } from '../src/wa.js';

async function control(action: 'cut' | 'restore'): Promise<void> {
  const response = await fetch(`${stack().controlUrl}/broker/${action}`, { method: 'POST' });
  expect(response.status).toBe(200);
}

const status = async (url: string): Promise<number> => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).status;
  } catch {
    return 0;
  }
};

describe('resilience', { timeout: 120_000 }, () => {
  let tenant: TenantFixture;
  const keyword = () => `ANTRE ${tenant.slug} ${tenant.locationCode}`;

  const createStaffTicket = (name: string, phone?: string) =>
    api('POST', '/api/v1/queues/tickets', {
      token: tenant.cashier.token,
      body: {
        location_id: tenant.locationId,
        service_id: tenant.freeServiceId,
        customer_name: name,
        ...(phone === undefined ? {} : { customer_phone: phone }),
      },
    });

  beforeAll(async () => {
    tenant = await provisionTenant({ prefix: 'resil' });
  });

  afterAll(async () => {
    // Whatever happened in a test, leave the broker reachable for the harness teardown.
    await control('restore');
  });

  describe('RabbitMQ unreachable', () => {
    const outageCustomer = new WaCustomer();
    const webhookCustomer = new WaCustomer();

    it('keeps issuing tickets and refuses the webhook with 503 so Meta retries', async () => {
      await control('cut');

      // The staff app does not depend on the broker: the ticket exists immediately.
      const ticket = await createStaffTicket('Saat Gangguan', outageCustomer.phone);
      expect(ticket.status).toBe(201);
      expect(ticket.body.ticket_number).toMatch(/^A-\d{3}$/);
      const listed = await api('GET', `/api/v1/queues/tickets?location_id=${tenant.locationId}`, {
        token: tenant.cashier.token,
      });
      expect(listed.body.tickets.map((t: { id: string }) => t.id)).toContain(ticket.body.id);

      // The webhook cannot hand the message to the broker, so it must not say 200.
      const webhook = await webhookCustomer.send(keyword());
      expect(webhook.status).toBe(503);

      // Services stay alive and say so.
      expect(await status(`${stack().coreUrl}/healthz`)).toBe(200);
      expect(await status(`${stack().waUrl}/healthz`)).toBe(200);
      expect(await status(`${stack().workerUrl}/healthz`)).toBe(200);
    });

    it('delivers the customer message and accepts webhooks again once the broker is back', async () => {
      await control('restore');

      const notice = await outageCustomer.nextReply(
        'the ticket message created during the outage',
        (m) => m.template === 'antre_ticket_created',
        60_000,
      );
      expect(notice.text).toContain('Nomor antrean Anda');

      // The webhook works again (Meta's retry would now succeed) and the chat flows end to end.
      await eventually(
        'the webhook accepting messages again',
        async () => (await webhookCustomer.send(keyword())).status === 200,
        { timeoutMs: 60_000, intervalMs: 500 },
      );
      const menu = await webhookCustomer.nextReply('menu', undefined, 30_000);
      expect(menu.text).toContain('Ambil Antrean');
      const services = await webhookCustomer.ask('1');
      expect(services.text).toContain('Konsultasi');
      const created = await webhookCustomer.ask('1');
      expect(created.template).toBe('antre_ticket_created');

      expect(await status(`${stack().coreUrl}/readyz`)).toBe(200);
      expect(await status(`${stack().waUrl}/readyz`)).toBe(200);
      expect(await status(`${stack().workerUrl}/readyz`)).toBe(200);
    });
  });

  describe('PostgreSQL connections terminated by the server', () => {
    let admin: pg.Client;

    const terminateAppConnections = async (): Promise<number> => {
      const result = await admin.query(
        `SELECT pg_terminate_backend(pid) AS ok
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND usename IN ('antre_app', 'antre_platform_admin')
            AND pid <> pg_backend_pid()`,
      );
      return result.rowCount ?? 0;
    };

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: stack().databaseUrls.admin });
      await admin.connect();
    });

    afterAll(async () => {
      await admin.end();
    });

    it('core-services survives repeated terminations and serves requests again', async () => {
      for (let round = 1; round <= 3; round += 1) {
        // Make sure there are pooled connections to kill.
        expect((await createStaffTicket(`Sebelum ${round}`)).status).toBe(201);
        expect(await terminateAppConnections()).toBeGreaterThan(0);

        // The process stays up (no crash on the pool error event) ...
        await eventually(
          `core /healthz after termination ${round}`,
          async () => (await status(`${stack().coreUrl}/healthz`)) === 200,
          { timeoutMs: 10_000 },
        );
        // ... and recovers on its own: the API works again without a restart.
        const recovered = await eventually(
          `a ticket after termination ${round}`,
          async () => {
            const response = await createStaffTicket(`Sesudah ${round}`);
            return response.status === 201 ? response : undefined;
          },
          { timeoutMs: 20_000, intervalMs: 250 },
        );
        expect(recovered.body.ticket_number).toMatch(/^A-\d{3}$/);
      }
      expect(await status(`${stack().coreUrl}/readyz`)).toBe(200);
    });

    it('the whole WhatsApp path (webhook, conversation, worker) works after the connections died', async () => {
      await terminateAppConnections();
      const customer = new WaCustomer();
      await eventually(
        'the webhook accepting the keyword',
        async () => (await customer.send(keyword())).status === 200,
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      await customer.nextReply('menu', undefined, 30_000);
      await customer.ask('1');
      const created = await customer.ask('1');
      expect(created.template).toBe('antre_ticket_created');

      for (const url of [stack().coreUrl, stack().waUrl, stack().workerUrl]) {
        expect(await status(`${url}/healthz`)).toBe(200);
      }
    });
  });
});
