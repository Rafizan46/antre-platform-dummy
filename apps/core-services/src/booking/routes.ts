// Staff endpoints of the booking calendar (/api/v1/bookings): the day calendar and the actions
// COMPLETE, NO_SHOW, and CANCEL.
import { bookingActionRequestSchema, bookingCalendarQuerySchema } from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth, requireRoles, withTenant, type AppDeps } from '../auth/plugin.js';
import { parseIdOr404, parseOrThrow } from '../errors.js';
import { applyStaffAction, listCalendar, runBooking, type BookingEnv } from './service.js';

export const bookingRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  const anyTenantRole = { preHandler: requireRoles('OWNER', 'STAFF_CALLER', 'STAFF_CASHIER') };
  const cashiers = { preHandler: requireRoles('OWNER', 'STAFF_CASHIER') };

  const envOf = (tenantId: string, log: BookingEnv['log']): BookingEnv => ({
    tenantId,
    now: deps.now(),
    slotLock: deps.slotLock,
    log,
  });

  app.get('/', anyTenantRole, async (request) => {
    const auth = requireAuth(request);
    const query = parseOrThrow(bookingCalendarQuerySchema, request.query);
    return withTenant(deps, auth, (client) =>
      listCalendar(client, envOf(auth.tenantId!, request.log), query.location_id, query.date),
    );
  });

  app.post<{ Params: { id: string } }>('/:id/actions', cashiers, async (request) => {
    const auth = requireAuth(request);
    const id = parseIdOr404(request.params.id, 'Reservasi tidak ditemukan.');
    const body = parseOrThrow(bookingActionRequestSchema, request.body);
    return runBooking(
      deps,
      request.log,
      (work) => withTenant(deps, auth, work),
      (client) => applyStaffAction(client, envOf(auth.tenantId!, request.log), id, body.action),
    );
  });
};
