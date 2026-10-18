// Core REST services (spec section 5.1): Tenant & Auth, Catalog, Queue, Booking, and the payment
// callback.
import Fastify from 'fastify';
import type pg from 'pg';

import { LoginRateLimiter } from './auth/login-rate-limiter.js';
import { createDummyVerifier } from './auth/password.js';
import { authenticate, type AppDeps } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { signKioskToken } from './auth/kiosk-tokens.js';
import { createTokenService } from './auth/tokens.js';
import { bookingRoutes } from './booking/routes.js';
import type { SlotLock } from './booking/slot-lock.js';
import { catalogRoutes } from './catalog/routes.js';
import { registerErrorHandling } from './errors.js';
import { NoopEventPublisher, type EventPublisher } from './events/publisher.js';
import { authenticateInternal } from './internal/plugin.js';
import { internalBookingRoutes } from './booking/internal-routes.js';
import { internalRoutes } from './internal/routes.js';
import { internalWaRoutes } from './internal/wa-routes.js';
import { locationsRoutes } from './locations/routes.js';
import { serializeRequest } from './log-redaction.js';
import { paymentRoutes } from './payments/routes.js';
import { queueRoutes } from './queue/routes.js';
import { InMemoryKioskRevocations, type KioskRevocations } from './realtime/redis-realtime.js';
import { tenantsRoutes } from './tenants/routes.js';
import { usersRoutes } from './users/routes.js';

export interface AppOptions {
  /** Pool of the antre_app role. The caller owns it and closes it. */
  pool: pg.Pool;
  jwtSecret: string;
  /** Static service token of the WhatsApp Channel Service for /internal/v1. */
  waChannelToken: string;
  /** Redis seam (or a fake) for the booking slot locks. */
  slotLock: SlotLock;
  /** HMAC secret of the QRIS payment callback. */
  paymentCallbackSecret: string;
  /** Defaults to a no-op publisher; server.ts passes the RabbitMQ publisher. */
  events?: EventPublisher;
  /** Defaults to an in-memory store; server.ts passes RedisRealtime (S10). */
  kioskRevocations?: KioskRevocations;
  now?: () => Date;
  /** true = JSON logs to stdout; a stream receives the lines instead (tests). */
  logger?: boolean | { stream: { write(line: string): void }; level?: string };
}

export function buildApp(options: AppOptions) {
  const logger = options.logger ?? false;
  const app = Fastify({
    // Phone numbers in /internal/v1 query strings are masked in the request log (S09).
    logger:
      logger === false
        ? false
        : { ...(logger === true ? {} : logger), serializers: { req: serializeRequest } },
  });
  const now = options.now ?? (() => new Date());

  const deps: AppDeps = {
    pool: options.pool,
    tokens: createTokenService({ secret: options.jwtSecret, now }),
    loginLimiter: new LoginRateLimiter({ now }),
    // Created now (not on first use) so the first unknown-email login is not faster than later ones.
    verifyDummyPassword: createDummyVerifier(),
    now,
    events: options.events ?? new NoopEventPublisher(),
    waChannelToken: options.waChannelToken,
    slotLock: options.slotLock,
    paymentCallbackSecret: options.paymentCallbackSecret,
    signKioskToken: (tenantId, locationId) =>
      signKioskToken({ secret: options.jwtSecret, tenantId, locationId, now: now() }),
    kioskRevocations: options.kioskRevocations ?? new InMemoryKioskRevocations(),
  };

  registerErrorHandling(app);
  app.decorateRequest('auth', null);
  app.decorateRequest('internalTenantId', null);

  app.get('/healthz', async () => ({ status: 'ok', service: 'core-services' }));

  // Public routes.
  app.register(authRoutes, { prefix: '/api/v1/auth', deps });

  // Payment provider callback: no JWT; authenticated by an HMAC over the raw body.
  app.register(paymentRoutes, { prefix: '/api/v1/payments', deps });

  // Everything else under /api/v1 requires a valid token (hook runs before routing handlers).
  app.register(
    async (scope) => {
      scope.addHook('onRequest', authenticate(deps));
      await scope.register(usersRoutes, { prefix: '/users', deps });
      await scope.register(tenantsRoutes, { prefix: '/tenants', deps });
      await scope.register(locationsRoutes, { prefix: '/locations', deps });
      await scope.register(catalogRoutes, { prefix: '/catalog', deps });
      await scope.register(queueRoutes, { prefix: '/queues', deps });
      await scope.register(bookingRoutes, { prefix: '/bookings', deps });
    },
    { prefix: '/api/v1' },
  );

  // Service-to-service routes of the WhatsApp Channel Service; never exposed through the gateway.
  app.register(
    async (scope) => {
      scope.addHook('onRequest', authenticateInternal(deps));
      await scope.register(internalRoutes, { deps });
      await scope.register(internalBookingRoutes, { deps });
      await scope.register(internalWaRoutes, { deps });
    },
    { prefix: '/internal/v1' },
  );

  return app;
}
