// Authentication building blocks: the bearer-token hook, role guard, and the tenant-scoped
// transaction wrapper every authenticated route uses.
import type { TenantRole } from '@antre/shared-types';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';

import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import type { EventPublisher } from '../events/publisher.js';
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
    const result = await client.query<{ role: string }>(
      'SELECT role FROM users WHERE id = $1 AND is_active',
      [auth.userId],
    );
    if (result.rows[0]?.role !== auth.role) throw unauthorized();
    return work(client);
  });
}
