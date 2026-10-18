// Owner billing routes (spec section 8, FR-BILLING-01..05) under /api/v1/billing, and the signed
// subscription callback under /api/v1/billing/payments (registered outside the JWT scope).
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth, requireRoles, withTenant, type AppDeps } from '../auth/plugin.js';
import { parseIdOr404 } from '../errors.js';
import { signedCallbackRoutes } from '../payments/routes.js';
import { listPlans } from './queries.js';
import { billingOverview, checkout, runSubscriptionCallback } from './service.js';

const LOCATION_NOT_FOUND = 'Lokasi tidak ditemukan.';

export const billingRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  const ownerOnly = { preHandler: requireRoles('OWNER') };

  app.get('/plans', ownerOnly, async (request) => {
    const auth = requireAuth(request);
    return { plans: await withTenant(deps, auth, listPlans) };
  });

  app.get<{ Params: { id: string } }>('/locations/:id/subscription', ownerOnly, async (request) => {
    const auth = requireAuth(request);
    const locationId = parseIdOr404(request.params.id, LOCATION_NOT_FOUND);
    return withTenant(deps, auth, (client) => billingOverview(client, locationId, deps.now()));
  });

  app.get<{ Params: { id: string } }>('/locations/:id/usage', ownerOnly, async (request) => {
    const auth = requireAuth(request);
    const locationId = parseIdOr404(request.params.id, LOCATION_NOT_FOUND);
    const overview = await withTenant(deps, auth, (client) =>
      billingOverview(client, locationId, deps.now()),
    );
    return { location_id: locationId, usage: overview.usage, history: overview.history };
  });

  app.post<{ Params: { id: string } }>(
    '/locations/:id/subscription/checkout',
    ownerOnly,
    async (request, reply) => {
      const auth = requireAuth(request);
      const locationId = parseIdOr404(request.params.id, LOCATION_NOT_FOUND);
      const result = await withTenant(deps, auth, (client) =>
        checkout(client, auth.tenantId!, locationId, deps.now(), request.log),
      );
      return reply.status(201).send(result);
    },
  );
};

/** POST /api/v1/billing/payments/callback: same signature and parsing as the booking callback. */
export const billingCallbackRoutes = signedCallbackRoutes('/callback', (deps, payload, log) =>
  runSubscriptionCallback(deps, payload, log),
);
