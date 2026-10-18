// Super Admin console API (FR-ADMIN-01, spec section 8) under /api/v1/admin: SUPER_ADMIN only, on
// the antre_platform_admin pool. Reads: tenants with locations, plan, subscription status, and
// usage; writes (S11): suspend or reactivate a tenant or a location.
import { uuidSchema } from '@antre/shared-types';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';

import { requireAuth, requireSuperAdmin, type AppDeps } from '../auth/plugin.js';
import { USAGE_HISTORY_MONTHS, usageSummary } from '../billing/subscription.js';
import { withTransaction } from '../db/transaction.js';
import { AppError, parseIdOr404, parseOrThrow } from '../errors.js';
import {
  getTenant,
  listTenants,
  locationsOf,
  setSuspended,
  usageByLocation,
  usageHistoryOf,
  type AdminLocationRow,
  type AdminTenantRow,
} from './queries.js';

const listQuerySchema = z.object({
  status: z.enum(['active', 'suspended']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const usageQuerySchema = z.object({
  period_month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-01$/)
    .optional(),
});

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function locationDto(row: AdminLocationRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    is_active: row.is_active,
    suspended: row.suspended_at !== null,
    suspended_at: iso(row.suspended_at),
    plan_code: row.plan_code,
    subscription_status: row.subscription_status,
    current_period_end: iso(row.current_period_end),
    usage: usageSummary(row.period_month, row.ticket_count, row.monthly_ticket_quota),
  };
}

function tenantDto(row: AdminTenantRow, locations: AdminLocationRow[]) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    business_type: row.business_type,
    service_mode: row.service_mode,
    created_at: row.created_at.toISOString(),
    suspended: row.suspended_at !== null,
    suspended_at: iso(row.suspended_at),
    locations: locations.filter((l) => l.tenant_id === row.id).map(locationDto),
  };
}

export const adminRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', requireSuperAdmin);

  /** One transaction on the antre_platform_admin pool (no tenant context). */
  function asPlatformAdmin<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (deps.platformAdminPool === null) {
      throw new AppError('INTERNAL_ERROR', 'Konsol admin belum dikonfigurasi.');
    }
    return withTransaction(deps.platformAdminPool, null, work);
  }

  app.get('/tenants', async (request) => {
    const query = parseOrThrow(listQuerySchema, request.query);
    const nowIso = deps.now().toISOString();
    return asPlatformAdmin(async (client) => {
      const page = await listTenants(client, query);
      const locations = await locationsOf(
        client,
        page.rows.map((row) => row.id),
        nowIso,
      );
      return {
        total: page.total,
        limit: query.limit,
        offset: query.offset,
        tenants: page.rows.map((row) => tenantDto(row, locations)),
      };
    });
  });

  app.get<{ Params: { id: string } }>('/tenants/:id', async (request) => {
    const id = parseIdOr404(request.params.id, 'Tenant tidak ditemukan.');
    const nowIso = deps.now().toISOString();
    return asPlatformAdmin(async (client) => {
      const tenant = await getTenant(client, id);
      if (tenant === null) throw new AppError('NOT_FOUND', 'Tenant tidak ditemukan.');
      const locations = await locationsOf(client, [id], nowIso);
      const history = await usageHistoryOf(
        client,
        locations.map((l) => l.id),
        USAGE_HISTORY_MONTHS,
      );
      const dto = tenantDto(tenant, locations);
      return {
        ...dto,
        locations: dto.locations.map((location) => ({
          ...location,
          history: history
            .filter((entry) => entry.location_id === location.id)
            .map(({ period_month, ticket_count }) => ({ period_month, ticket_count })),
        })),
      };
    });
  });

  app.get('/usage', async (request) => {
    const query = parseOrThrow(usageQuerySchema, request.query);
    const nowIso = deps.now().toISOString();
    const rows = await asPlatformAdmin((client) =>
      usageByLocation(client, query.period_month ?? null, nowIso),
    );
    return { period_month: query.period_month ?? null, locations: rows };
  });

  const suspension =
    (table: 'tenants' | 'locations', suspended: boolean) =>
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const notFound = table === 'tenants' ? 'Tenant tidak ditemukan.' : 'Lokasi tidak ditemukan.';
      if (!uuidSchema.safeParse(request.params.id).success) {
        throw new AppError('NOT_FOUND', notFound);
      }
      const now = deps.now().toISOString();
      const row = await asPlatformAdmin((client) =>
        setSuspended(client, table, request.params.id, suspended, now),
      );
      if (row === null) throw new AppError('NOT_FOUND', notFound);
      request.log.info(
        {
          audit: suspended ? 'suspend' : 'activate',
          target: table === 'tenants' ? 'tenant' : 'location',
          target_id: row.id,
          admin_id: requireAuth(request).userId,
        },
        'platform admin action',
      );
      return {
        id: row.id,
        suspended: row.suspended_at !== null,
        suspended_at: iso(row.suspended_at),
      };
    };

  app.post<{ Params: { id: string } }>('/tenants/:id/suspend', suspension('tenants', true));
  app.post<{ Params: { id: string } }>('/tenants/:id/activate', suspension('tenants', false));
  app.post<{ Params: { id: string } }>('/locations/:id/suspend', suspension('locations', true));
  app.post<{ Params: { id: string } }>('/locations/:id/activate', suspension('locations', false));
};
