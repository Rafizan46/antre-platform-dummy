// FR-AUTH-06: locations of a tenant (GET/POST /locations, PATCH /locations/:id).
import { createLocationRequestSchema, updateLocationRequestSchema } from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth, requireRoles, withTenant, type AppDeps } from '../auth/plugin.js';
import { AppError, parseIdOr404, parseOrThrow, uniqueViolationConstraint } from '../errors.js';
import { insertLocation, listLocations, locationExists, updateLocation } from './queries.js';

export const locationsRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  const ownerOnly = { preHandler: requireRoles('OWNER') };

  app.get(
    '/',
    { preHandler: requireRoles('OWNER', 'STAFF_CALLER', 'STAFF_CASHIER') },
    async (request) => {
      const auth = requireAuth(request);
      const locations = await withTenant(deps, auth, (client) => listLocations(client));
      return { locations };
    },
  );

  app.post('/', ownerOnly, async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(createLocationRequestSchema, request.body);
    try {
      const location = await withTenant(deps, auth, (client) =>
        insertLocation(client, auth.tenantId!, body),
      );
      return await reply.status(201).send(location);
    } catch (error) {
      if (uniqueViolationConstraint(error) === 'locations_tenant_id_code_key') {
        throw new AppError('ALREADY_EXISTS', 'Kode lokasi sudah dipakai.', {
          details: { field: 'code' },
        });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/:id', ownerOnly, async (request) => {
    const auth = requireAuth(request);
    const id = parseIdOr404(request.params.id, 'Lokasi tidak ditemukan.');
    const body = parseOrThrow(updateLocationRequestSchema, request.body);
    const location = await withTenant(deps, auth, (client) => updateLocation(client, id, body));
    if (location === null) throw new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.');
    return location;
  });

  // FR-REALTIME-02 (S10): KIOSK_DISPLAY token of a location, valid 30 days, for the Kiosk TV stream.
  app.post<{ Params: { id: string } }>('/:id/kiosk-tokens', ownerOnly, async (request, reply) => {
    const auth = requireAuth(request);
    const id = parseIdOr404(request.params.id, 'Lokasi tidak ditemukan.');
    if (!(await withTenant(deps, auth, (client) => locationExists(client, id)))) {
      throw new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.');
    }
    const kiosk = await deps.signKioskToken(auth.tenantId!, id);
    return reply.status(201).send({
      token: kiosk.token,
      token_id: kiosk.tokenId,
      location_id: id,
      expires_in: kiosk.expiresIn,
      expires_at: kiosk.expiresAt.toISOString(),
    });
  });

  // S10: revokes every KIOSK_DISPLAY token of the location issued until now; open kiosk streams
  // close and must be given a new token.
  app.delete<{ Params: { id: string } }>('/:id/kiosk-tokens', ownerOnly, async (request, reply) => {
    const auth = requireAuth(request);
    const id = parseIdOr404(request.params.id, 'Lokasi tidak ditemukan.');
    if (!(await withTenant(deps, auth, (client) => locationExists(client, id)))) {
      throw new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.');
    }
    await deps.kioskRevocations.revokeAll(auth.tenantId!, id, deps.now());
    return reply.status(204).send();
  });
};
