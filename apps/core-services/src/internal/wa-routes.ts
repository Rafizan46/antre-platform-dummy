// /internal/v1 endpoints of Tenant & Auth for the WhatsApp Channel Service (spec section 8):
//   GET /locations/resolve?slug=&code=        QR keyword -> tenant + location (tenantless)
//   GET /locations/:id/wa-context             names, service mode, estimate toggle, branding
//   GET /customers/active-items?customer_phone= active items of a phone in all tenants (tenantless)
// The service token is checked by the scope hook; tenantless routes ignore X-Antre-Tenant-Id.
import { activeItemsQuerySchema, resolveLocationQuerySchema } from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import type { AppDeps } from '../auth/plugin.js';
import { AppError, parseIdOr404, parseOrThrow } from '../errors.js';
import { requireInternalTenant, withInternalTenant } from './plugin.js';
import { findActiveItems, getWaContext, resolveLocation } from './queries.js';

export const internalWaRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get('/locations/resolve', { config: { tenantless: true } }, async (request) => {
    const query = parseOrThrow(resolveLocationQuerySchema, request.query);
    const location = await resolveLocation(deps.pool, query.slug, query.code);
    if (location === null) throw new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.');
    return location;
  });

  app.get<{ Params: { id: string } }>('/locations/:id/wa-context', async (request) => {
    const tenantId = requireInternalTenant(request);
    const id = parseIdOr404(request.params.id, 'Lokasi tidak ditemukan.');
    const context = await withInternalTenant(deps, tenantId, (client) => getWaContext(client, id));
    if (context === null) throw new AppError('NOT_FOUND', 'Lokasi tidak ditemukan.');
    return context;
  });

  app.get('/customers/active-items', { config: { tenantless: true } }, async (request) => {
    const query = parseOrThrow(activeItemsQuerySchema, request.query);
    return { items: await findActiveItems(deps.pool, query.customer_phone) };
  });
};
