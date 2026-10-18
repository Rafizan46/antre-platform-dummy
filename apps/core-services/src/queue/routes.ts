// FR-QUEUE-04..06 and FR-DASHBOARD-01 for staff: manual tickets, today's list, CALL_NEXT, and
// per-ticket actions (/queues/*).
import {
  callNextRequestSchema,
  createStaffTicketRequestSchema,
  listTicketsQuerySchema,
  ticketActionRequestSchema,
} from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth, requireRoles, withTenant, type AppDeps } from '../auth/plugin.js';
import { parseIdOr404, parseOrThrow } from '../errors.js';
import { applyAction, callNext, createTicket, listTickets, runQueue } from './service.js';

export const queueRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  const anyTenantRole = { preHandler: requireRoles('OWNER', 'STAFF_CALLER', 'STAFF_CASHIER') };
  const callers = { preHandler: requireRoles('OWNER', 'STAFF_CALLER') };

  app.post('/tickets', anyTenantRole, async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(createStaffTicketRequestSchema, request.body);
    const ticket = await runQueue(
      deps,
      request.log,
      (work) => withTenant(deps, auth, work),
      (client) =>
        createTicket(
          client,
          { tenantId: auth.tenantId!, now: deps.now() },
          {
            channel: 'STAFF',
            locationId: body.location_id,
            serviceId: body.service_id,
            customerName: body.customer_name,
            customerPhone: body.customer_phone ?? null,
          },
        ),
    );
    return reply.status(201).send(ticket);
  });

  app.get('/tickets', anyTenantRole, async (request) => {
    const auth = requireAuth(request);
    const query = parseOrThrow(listTicketsQuerySchema, request.query);
    const tickets = await withTenant(deps, auth, (client) =>
      listTickets(
        client,
        { tenantId: auth.tenantId!, now: deps.now() },
        query.location_id,
        query.status,
      ),
    );
    return { tickets };
  });

  app.post('/tickets/call-next', callers, async (request) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(callNextRequestSchema, request.body);
    return runQueue(
      deps,
      request.log,
      (work) => withTenant(deps, auth, work),
      (client) =>
        callNext(
          client,
          { tenantId: auth.tenantId!, now: deps.now() },
          {
            locationId: body.location_id,
            serviceId: body.service_id,
            resourceId: body.resource_id,
          },
        ),
    );
  });

  app.post<{ Params: { id: string } }>('/tickets/:id/actions', callers, async (request) => {
    const auth = requireAuth(request);
    const id = parseIdOr404(request.params.id, 'Tiket tidak ditemukan.');
    const body = parseOrThrow(ticketActionRequestSchema, request.body);
    return runQueue(
      deps,
      request.log,
      (work) => withTenant(deps, auth, work),
      (client) =>
        applyAction(client, { tenantId: auth.tenantId!, now: deps.now() }, id, body.action),
    );
  });
};
