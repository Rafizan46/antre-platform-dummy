// FR-AUTH-06: locations of a tenant (GET/POST /locations, PATCH /locations/:id).
import { createLocationRequestSchema, updateLocationRequestSchema } from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth, requireRoles, withTenant, type AppDeps } from '../auth/plugin.js';
import { AppError, parseIdOr404, parseOrThrow, uniqueViolationConstraint } from '../errors.js';
import { insertLocation, listLocations, updateLocation } from './queries.js';

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
};
