// Service-to-service endpoints for the WhatsApp Channel Service (/internal/v1): take, check, and
// cancel a ticket, and list the services for the WhatsApp menu. Auth is done by the scope hook.
import {
  activeTicketQuerySchema,
  cancelTicketRequestSchema,
  createWaTicketRequestSchema,
  internalServicesQuerySchema,
} from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import type { AppDeps } from '../auth/plugin.js';
import { listActiveServices } from '../queue/queries.js';
import { cancelTicket, createTicket, findActive, runQueue } from '../queue/service.js';
import { parseIdOr404, parseOrThrow } from '../errors.js';
import { requireInternalTenant, withInternalTenant } from './plugin.js';

export const internalRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get('/catalog/services', async (request) => {
    const tenantId = requireInternalTenant(request);
    const query = parseOrThrow(internalServicesQuerySchema, request.query);
    const services = await withInternalTenant(deps, tenantId, (client) =>
      listActiveServices(client, query.location_id),
    );
    return { services };
  });

  app.post('/queues/tickets', async (request, reply) => {
    const tenantId = requireInternalTenant(request);
    const body = parseOrThrow(createWaTicketRequestSchema, request.body);
    const ticket = await runQueue(
      deps,
      request.log,
      (work) => withInternalTenant(deps, tenantId, work),
      (client) =>
        createTicket(
          client,
          { tenantId, now: deps.now() },
          {
            channel: 'WHATSAPP',
            locationId: body.location_id,
            serviceId: body.service_id,
            customerName: body.customer_name,
            customerPhone: body.customer_phone,
          },
        ),
    );
    return reply.status(201).send(ticket);
  });

  app.get('/queues/tickets/active', async (request) => {
    const tenantId = requireInternalTenant(request);
    const query = parseOrThrow(activeTicketQuerySchema, request.query);
    return withInternalTenant(deps, tenantId, (client) =>
      findActive(client, { tenantId, now: deps.now() }, query.location_id, query.customer_phone),
    );
  });

  app.post<{ Params: { id: string } }>('/queues/tickets/:id/cancel', async (request) => {
    const tenantId = requireInternalTenant(request);
    const id = parseIdOr404(request.params.id, 'Tiket tidak ditemukan.');
    const body = parseOrThrow(cancelTicketRequestSchema, request.body);
    return runQueue(
      deps,
      request.log,
      (work) => withInternalTenant(deps, tenantId, work),
      (client) => cancelTicket(client, { tenantId, now: deps.now() }, id, body.customer_phone),
    );
  });
};
