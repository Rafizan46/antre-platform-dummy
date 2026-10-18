// FR-CATALOG-01..03: services, resources, and operating hours (/catalog/*).
import {
  createResourceRequestSchema,
  createServiceRequestSchema,
  listResourcesQuerySchema,
  putOperatingHoursRequestSchema,
  updateResourceRequestSchema,
  updateServiceRequestSchema,
} from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';

import { requireAuth, requireRoles, withTenant, type AppDeps } from '../auth/plugin.js';
import {
  AppError,
  foreignKeyViolation,
  parseIdOr404,
  parseOrThrow,
  uniqueViolationConstraint,
} from '../errors.js';
import {
  allServicesVisible,
  getOperatingHours,
  getResource,
  insertResource,
  insertService,
  listResources,
  listServices,
  locationVisible,
  putOperatingHours,
  replaceResourceServices,
  updateResource,
  updateService,
} from './queries.js';

const PREFIX_TAKEN = 'services_tenant_id_ticket_prefix_key';

function prefixTaken(): AppError {
  return new AppError('ALREADY_EXISTS', 'Prefix tiket sudah dipakai layanan lain.', {
    details: { field: 'ticket_prefix' },
  });
}

const notFound = {
  location: () => new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.'),
  service: () => new AppError('NOT_FOUND', 'Layanan tidak ditemukan.'),
  resource: () => new AppError('NOT_FOUND', 'Resource tidak ditemukan.'),
};

export const catalogRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  const ownerOnly = { preHandler: requireRoles('OWNER') };
  const anyTenantRole = { preHandler: requireRoles('OWNER', 'STAFF_CALLER', 'STAFF_CASHIER') };

  // Services (FR-CATALOG-02)

  app.get('/services', anyTenantRole, async (request) => {
    const auth = requireAuth(request);
    return { services: await withTenant(deps, auth, (client) => listServices(client)) };
  });

  app.post('/services', ownerOnly, async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(createServiceRequestSchema, request.body);
    try {
      const service = await withTenant(deps, auth, (client) =>
        insertService(client, auth.tenantId!, body),
      );
      return await reply.status(201).send(service);
    } catch (error) {
      if (uniqueViolationConstraint(error) === PREFIX_TAKEN) throw prefixTaken();
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/services/:id', ownerOnly, async (request) => {
    const auth = requireAuth(request);
    const id = parseIdOr404(request.params.id, 'Layanan tidak ditemukan.');
    const body = parseOrThrow(updateServiceRequestSchema, request.body);
    try {
      const service = await withTenant(deps, auth, (client) => updateService(client, id, body));
      if (service === null) throw notFound.service();
      return service;
    } catch (error) {
      if (uniqueViolationConstraint(error) === PREFIX_TAKEN) throw prefixTaken();
      throw error;
    }
  });

  // Resources (FR-CATALOG-01)

  app.get('/resources', anyTenantRole, async (request) => {
    const auth = requireAuth(request);
    const query = parseOrThrow(listResourcesQuerySchema, request.query);
    return {
      resources: await withTenant(deps, auth, (client) => listResources(client, query.location_id)),
    };
  });

  app.post('/resources', ownerOnly, async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(createResourceRequestSchema, request.body);
    try {
      const resource = await withTenant(deps, auth, async (client) => {
        if (!(await locationVisible(client, body.location_id))) throw notFound.location();
        if (!(await allServicesVisible(client, body.service_ids))) throw notFound.service();
        const id = await insertResource(client, auth.tenantId!, body);
        return (await getResource(client, id))!;
      });
      return await reply.status(201).send(resource);
    } catch (error) {
      if (foreignKeyViolation(error)) throw notFound.location();
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/resources/:id', ownerOnly, async (request) => {
    const auth = requireAuth(request);
    const id = parseIdOr404(request.params.id, 'Resource tidak ditemukan.');
    const body = parseOrThrow(updateResourceRequestSchema, request.body);
    try {
      const resource = await withTenant(deps, auth, async (client) => {
        if (!(await updateResource(client, id, body))) throw notFound.resource();
        if (body.service_ids !== undefined) {
          if (!(await allServicesVisible(client, body.service_ids))) throw notFound.service();
          await replaceResourceServices(client, auth.tenantId!, id, body.service_ids);
        }
        return (await getResource(client, id))!;
      });
      return resource;
    } catch (error) {
      if (foreignKeyViolation(error)) throw notFound.service();
      throw error;
    }
  });

  // Operating hours (FR-CATALOG-03)

  app.get<{ Params: { location_id: string } }>(
    '/locations/:location_id/operating-hours',
    anyTenantRole,
    async (request) => {
      const auth = requireAuth(request);
      const locationId = parseIdOr404(request.params.location_id, 'Lokasi tidak ditemukan.');
      const hours = await withTenant(deps, auth, (client) => getOperatingHours(client, locationId));
      if (hours === null) throw notFound.location();
      return hours;
    },
  );

  app.put<{ Params: { location_id: string } }>(
    '/locations/:location_id/operating-hours',
    ownerOnly,
    async (request) => {
      const auth = requireAuth(request);
      const locationId = parseIdOr404(request.params.location_id, 'Lokasi tidak ditemukan.');
      const body = parseOrThrow(putOperatingHoursRequestSchema, request.body);
      const hours = await withTenant(deps, auth, async (client: pg.PoolClient) => {
        if (!(await putOperatingHours(client, auth.tenantId!, locationId, body))) {
          throw notFound.location();
        }
        return getOperatingHours(client, locationId);
      });
      return hours;
    },
  );
};
