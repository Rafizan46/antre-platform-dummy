// Public auth routes: POST /register (FR-AUTH-01) and POST /login (FR-AUTH-02).
import { randomUUID } from 'node:crypto';

import {
  loginRequestSchema,
  registerRequestSchema,
  type LoginResponse,
  type RegisterResponse,
} from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import { withTransaction } from '../db/transaction.js';
import { AppError, parseOrThrow, uniqueViolationConstraint } from '../errors.js';
import { toUserDto } from '../users/queries.js';
import { hashPassword, verifyPassword } from './password.js';
import type { AppDeps } from './plugin.js';
import { findUserForLogin, insertTenantWithOwner } from './queries.js';

function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 'Email atau password salah.');
}

export const authRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.post('/register', async (request, reply) => {
    const body = parseOrThrow(registerRequestSchema, request.body);
    // Hashing is slow: do it before the transaction so no connection is held meanwhile.
    const passwordHash = await hashPassword(body.owner.password);
    const tenantId = randomUUID();

    try {
      const registered = await withTransaction(deps.pool, tenantId, (client) =>
        insertTenantWithOwner(client, tenantId, body, passwordHash),
      );
      const response: RegisterResponse = {
        tenant: registered.tenant,
        location: registered.location,
        user: toUserDto(registered.owner),
      };
      return await reply.status(201).send(response);
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint === 'tenants_slug_key') {
        throw new AppError('ALREADY_EXISTS', 'Slug sudah dipakai.', { details: { field: 'slug' } });
      }
      if (constraint === 'users_email_key') {
        throw new AppError('ALREADY_EXISTS', 'Email sudah terdaftar.', {
          details: { field: 'email' },
        });
      }
      throw error;
    }
  });

  app.post('/login', async (request): Promise<LoginResponse> => {
    const body = parseOrThrow(loginRequestSchema, request.body);

    // Count the attempt synchronously, before any await, so parallel guesses cannot all pass.
    const key = `${request.ip}|${body.email}`;
    const decision = deps.loginLimiter.consume(key);
    if (decision.blocked) {
      throw new AppError('RATE_LIMITED', 'Terlalu banyak percobaan login. Coba lagi nanti.', {
        headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      });
    }

    const user = await findUserForLogin(deps.pool, body.email);
    if (user === null) {
      // Same work as a real verification, so timing does not reveal unknown emails.
      await deps.verifyDummyPassword(body.password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      throw invalidCredentials();
    }

    deps.loginLimiter.reset(key);
    const { token, expiresIn } = await deps.tokens.sign({
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
    });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      user: { id: user.id, email: body.email, role: user.role, tenant_id: user.tenant_id },
    };
  });
};
