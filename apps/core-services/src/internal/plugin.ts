// Authentication of /internal/v1 (WhatsApp Channel Service). A static service token identifies the
// caller; the tenant it acts for comes from the X-Antre-Tenant-Id header. /internal/v1 must never
// be routed through the public gateway.
import { createHash, timingSafeEqual } from 'node:crypto';

import { uuidSchema } from '@antre/shared-types';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';

import type { AppDeps } from '../auth/plugin.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    internalTenantId: string | null;
  }
  interface FastifyContextConfig {
    /**
     * The route runs before the tenant is known (locations/resolve, customers/active-items, spec
     * section 8): X-Antre-Tenant-Id is not required and is ignored.
     */
    tenantless?: boolean;
  }
}

const BEARER_PATTERN = /^Bearer ([^\s]+)$/;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison: both values are hashed to equal length first. */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/** onRequest hook: service token first (401), then the tenant header (400) unless tenantless. */
export function authenticateInternal(deps: AppDeps) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    const token = header === undefined ? undefined : BEARER_PATTERN.exec(header)?.[1];
    if (token === undefined || !tokenMatches(token, deps.waChannelToken)) {
      throw new AppError('UNAUTHORIZED', 'Autentikasi diperlukan atau token tidak valid.');
    }

    if (request.routeOptions.config?.tenantless === true) {
      request.internalTenantId = null;
      return;
    }
    const tenantId = uuidSchema.safeParse(request.headers['x-antre-tenant-id']);
    if (!tenantId.success) {
      throw new AppError('VALIDATION_ERROR', 'Header X-Antre-Tenant-Id wajib berupa uuid.');
    }
    request.internalTenantId = tenantId.data;
  };
}

export function requireInternalTenant(request: FastifyRequest): string {
  if (request.internalTenantId === null) {
    throw new AppError('UNAUTHORIZED', 'Autentikasi diperlukan atau token tidak valid.');
  }
  return request.internalTenantId;
}

/** Runs `work` in a transaction in the tenant context of the header; 404 when the tenant is unknown. */
export async function withInternalTenant<T>(
  deps: AppDeps,
  tenantId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(deps.pool, tenantId, async (client) => {
    const result = await client.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
    if (result.rowCount === 0) throw new AppError('NOT_FOUND', 'Tenant tidak ditemukan.');
    return work(client);
  });
}
