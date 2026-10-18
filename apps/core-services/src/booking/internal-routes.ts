// Service-to-service booking endpoints for the WhatsApp Channel Service (/internal/v1/bookings):
// free slots, hold a slot, list active bookings, and cancel. Auth is done by the scope hook.
import {
  activeBookingsQuerySchema,
  availableSlotsQuerySchema,
  cancelBookingRequestSchema,
  createHoldRequestSchema,
} from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import type { AppDeps } from '../auth/plugin.js';
import { parseIdOr404, parseOrThrow } from '../errors.js';
import { requireInternalTenant, withInternalTenant } from '../internal/plugin.js';
import {
  cancelByCustomer,
  createHold,
  findActiveBookings,
  listAvailableSlots,
  runBooking,
  type BookingEnv,
} from './service.js';

export const internalBookingRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (
  app,
  { deps },
) => {
  const envOf = (tenantId: string, log: BookingEnv['log']): BookingEnv => ({
    tenantId,
    now: deps.now(),
    slotLock: deps.slotLock,
    log,
  });

  app.get('/bookings/available-slots', async (request) => {
    const tenantId = requireInternalTenant(request);
    const query = parseOrThrow(availableSlotsQuerySchema, request.query);
    return withInternalTenant(deps, tenantId, (client) =>
      listAvailableSlots(
        client,
        envOf(tenantId, request.log),
        query.location_id,
        query.service_id,
        query.date,
      ),
    );
  });

  app.post('/bookings/holds', async (request, reply) => {
    const tenantId = requireInternalTenant(request);
    const body = parseOrThrow(createHoldRequestSchema, request.body);
    const booking = await runBooking(
      deps,
      request.log,
      (work) => withInternalTenant(deps, tenantId, work),
      (client, tracker) =>
        createHold(client, envOf(tenantId, request.log), tracker, {
          locationId: body.location_id,
          serviceId: body.service_id,
          slotStart: body.slot_start,
          customerName: body.customer_name,
          customerPhone: body.customer_phone,
        }),
    );
    return reply.status(201).send(booking);
  });

  app.get('/bookings/active', async (request) => {
    const tenantId = requireInternalTenant(request);
    const query = parseOrThrow(activeBookingsQuerySchema, request.query);
    return withInternalTenant(deps, tenantId, (client) =>
      findActiveBookings(
        client,
        envOf(tenantId, request.log),
        query.location_id,
        query.customer_phone,
      ),
    );
  });

  app.post<{ Params: { id: string } }>('/bookings/:id/cancel', async (request) => {
    const tenantId = requireInternalTenant(request);
    const id = parseIdOr404(request.params.id, 'Reservasi tidak ditemukan.');
    const body = parseOrThrow(cancelBookingRequestSchema, request.body);
    return runBooking(
      deps,
      request.log,
      (work) => withInternalTenant(deps, tenantId, work),
      (client) => cancelByCustomer(client, envOf(tenantId, request.log), id, body.customer_phone),
    );
  });
};
