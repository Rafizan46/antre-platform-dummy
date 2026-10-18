// Authentication building blocks: the bearer-token hook, role guard, and the tenant-scoped
// transaction wrapper every authenticated route uses.
import type { TenantRole } from '@antre/shared-types';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';

import type { SlotLock } from '../booking/slot-lock.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import type { EventPublisher } from '../events/publisher.js';
import type { KioskRevocations } from '../realtime/redis-realtime.js';
import type { KioskToken } from './kiosk-tokens.js';
import type { LoginRateLimiter } from './login-rate-limiter.js';
import type { AuthContext, TokenService } from './tokens.js';

export interface AppDeps {
  /** Pool of the antre_app role; owned (and closed) by the caller of buildApp. */
  pool: pg.Pool;
  tokens: TokenService;
  loginLimiter: LoginRateLimiter;
  verifyDummyPassword: (password: string) => Promise<boolean>;
  now: () => Date;
  events: EventPublisher;
  /** Static service token of the WhatsApp Channel Service (/internal/v1). */
  waChannelToken: string;
  /** Redis seam for the booking slot locks (spec section 7.2). */
  slotLock: SlotLock;
  /** HMAC secret of the QRIS payment callback (spec section 7.4). */
  paymentCallbackSecret: string;
  /** Issues a KIOSK_DISPLAY token for a location (FR-REALTIME-02). */
  signKioskToken: (tenantId: string, locationId: string) => Promise<KioskToken>;
  /** Revocation store of the KIOSK_DISPLAY tokens (Redis, read by the Realtime SSE Gateway). */
  kioskRevocations: KioskRevocations;
  /**
   * Pool of the antre_platform_admin role for /api/v1/admin (FR-ADMIN-01); null when
   * DATABASE_PLATFORM_ADMIN_URL is not configured (the admin routes then answer 500).
   */
  platformAdminPool: pg.Pool | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const BEARER_PATTERN = /^Bearer ([^\s]+)$/;

function unauthorized(): AppError {
  return new AppError('UNAUTHORIZED', 'Autentikasi diperlukan atau token tidak valid.');
}

/** onRequest hook: fail closed unless a valid bearer token is presented. */
export function authenticate(deps: AppDeps) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    const token = header === undefined ? undefined : BEARER_PATTERN.exec(header)?.[1];
    if (token === undefined) throw unauthorized();

    const auth = await deps.tokens.verify(token);
    if (auth === null) throw unauthorized();
    request.auth = auth;
  };
}

/** The authenticated context of a request that passed `authenticate`. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (request.auth === null) throw unauthorized();
  return request.auth;
}

/** preHandler: only the listed tenant roles pass. SUPER_ADMIN is never listed, so it gets 403. */
export function requireRoles(...roles: TenantRole[]) {
  return async (request: FastifyRequest): Promise<void> => {
    const { role } = requireAuth(request);
    if (!(roles as string[]).includes(role)) {
      throw new AppError('FORBIDDEN', 'Anda tidak memiliki akses ke sumber daya ini.');
    }
  };
}

/**
 * Runs `work` in a transaction in the token's tenant context. The user must still exist, be
 * active, and have the role in the token, so deactivated or re-roled accounts lose access at once.
 */
export async function withTenant<T>(
  deps: AppDeps,
  auth: AuthContext,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (auth.tenantId === null) {
    throw new AppError('FORBIDDEN', 'Akun ini tidak terikat pada tenant.');
  }
  return withTransaction(deps.pool, auth.tenantId, async (client) => {
    const result = await client.query<{ role: string; suspended: boolean }>(
      `SELECT u.role, t.suspended_at IS NOT NULL AS suspended
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 AND u.is_active`,
      [auth.userId],
    );
    const user = result.rows[0];
    if (user?.role !== auth.role) throw unauthorized();
    // S11: a tenant suspended by the Super Admin loses access to every staff and owner route.
    if (user.suspended) {
      throw new AppError(
        'FORBIDDEN',
        'Akun usaha ini sedang ditangguhkan oleh administrator platform.',
        {
          details: { reason: 'TENANT_SUSPENDED' },
        },
      );
    }
    return work(client);
  });
}

/** preHandler of /api/v1/admin: SUPER_ADMIN only (FR-AUTH-02); tenant roles get 403. */
export async function requireSuperAdmin(request: FastifyRequest): Promise<void> {
  const auth = requireAuth(request);
  if (auth.role !== 'SUPER_ADMIN' || auth.tenantId !== null) {
    throw new AppError('FORBIDDEN', 'Anda tidak memiliki akses ke sumber daya ini.');
  }
}
