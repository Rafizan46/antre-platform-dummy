// Core REST services (spec section 5.1). Currently Tenant & Auth: register, login, staff, and
// tenant settings. Catalog, Queue, and Booking routes are added in later workstreams.
import Fastify from 'fastify';
import type pg from 'pg';

import { LoginRateLimiter } from './auth/login-rate-limiter.js';
import { createDummyVerifier } from './auth/password.js';
import { authenticate, type AppDeps } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { createTokenService } from './auth/tokens.js';
import { registerErrorHandling } from './errors.js';
import { tenantsRoutes } from './tenants/routes.js';
import { usersRoutes } from './users/routes.js';

export interface AppOptions {
  /** Pool of the antre_app role. The caller owns it and closes it. */
  pool: pg.Pool;
  jwtSecret: string;
  now?: () => Date;
  logger?: boolean;
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false });
  const now = options.now ?? (() => new Date());

  const deps: AppDeps = {
    pool: options.pool,
    tokens: createTokenService({ secret: options.jwtSecret, now }),
    loginLimiter: new LoginRateLimiter({ now }),
    // Created now (not on first use) so the first unknown-email login is not faster than later ones.
    verifyDummyPassword: createDummyVerifier(),
    now,
  };

  registerErrorHandling(app);
  app.decorateRequest('auth', null);

  app.get('/healthz', async () => ({ status: 'ok', service: 'core-services' }));

  // Public routes.
  app.register(authRoutes, { prefix: '/api/v1/auth', deps });

  // Everything else under /api/v1 requires a valid token (hook runs before routing handlers).
  app.register(
    async (scope) => {
      scope.addHook('onRequest', authenticate(deps));
      await scope.register(usersRoutes, { prefix: '/users', deps });
      await scope.register(tenantsRoutes, { prefix: '/tenants', deps });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
