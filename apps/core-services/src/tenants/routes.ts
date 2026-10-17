// FR-AUTH-04/05: tenant settings and branding (GET/PATCH /tenants/me/settings).
import { updateTenantSettingsRequestSchema } from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth, requireRoles, withTenant, type AppDeps } from '../auth/plugin.js';
import { AppError, parseOrThrow } from '../errors.js';
import { getTenantSettings, updateTenantSettings } from './queries.js';

export const tenantsRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get(
    '/me/settings',
    { preHandler: requireRoles('OWNER', 'STAFF_CALLER', 'STAFF_CASHIER') },
    async (request) => {
      const auth = requireAuth(request);
      const settings = await withTenant(deps, auth, (client) =>
        getTenantSettings(client, auth.tenantId!),
      );
      if (settings === null) throw new AppError('NOT_FOUND', 'Tenant tidak ditemukan.');
      return settings;
    },
  );

  app.patch('/me/settings', { preHandler: requireRoles('OWNER') }, async (request) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(updateTenantSettingsRequestSchema, request.body);
    const settings = await withTenant(deps, auth, (client) =>
      updateTenantSettings(client, auth.tenantId!, body),
    );
    if (settings === null) throw new AppError('NOT_FOUND', 'Tenant tidak ditemukan.');
    return settings;
  });
};
