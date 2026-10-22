// Core REST services (spec section 5.1): Tenant & Auth, Catalog, Queue, Booking, the payment
// callbacks, Billing (S11), and the Super Admin console (S11).
import Fastify from 'fastify';
import type pg from 'pg';

import { LoginRateLimiter } from './auth/login-rate-limiter.js';
import { createDummyVerifier } from './auth/password.js';
import { authenticate, type AppDeps } from './auth/plugin.js';
import { adminRoutes } from './admin/routes.js';
import { authRoutes } from './auth/routes.js';
import { billingCallbackRoutes, billingRoutes } from './billing/routes.js';
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
import { CoreMetrics } from './metrics.js';
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
  /** Pool of the antre_platform_admin role (Super Admin console); the caller owns it. */
  platformAdminPool?: pg.Pool;
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
  const metrics = new CoreMetrics();
  metrics.addPool('app', options.pool);
  if (options.platformAdminPool) metrics.addPool('platform_admin', options.platformAdminPool);
  const basePublisher = options.events ?? new NoopEventPublisher();

  const deps: AppDeps = {
    pool: options.pool,
    tokens: createTokenService({ secret: options.jwtSecret, now }),
    loginLimiter: new LoginRateLimiter({ now }),
    // Created now (not on first use) so the first unknown-email login is not faster than later ones.
    verifyDummyPassword: createDummyVerifier(),
    now,
    events: {
      publish: async (event) => {
        metrics.observeEvent(event.event_type);
        await basePublisher.publish(event);
      },
    },
    waChannelToken: options.waChannelToken,
    slotLock: options.slotLock,
    paymentCallbackSecret: options.paymentCallbackSecret,
    signKioskToken: (tenantId, locationId) =>
      signKioskToken({ secret: options.jwtSecret, tenantId, locationId, now: now() }),
    kioskRevocations: options.kioskRevocations ?? new InMemoryKioskRevocations(),
    platformAdminPool: options.platformAdminPool ?? null,
  };

  registerErrorHandling(app);
  app.decorateRequest('auth', null);
  app.decorateRequest('internalTenantId', null);

  app.get('/healthz', async () => ({ status: 'ok', service: 'core-services' }));

  // Readiness: 503 while the database is unreachable (never routed through the gateway).
  app.get('/readyz', async (_request, reply) => {
    try {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('database ping timed out')), 2000);
      });
      try {
        await Promise.race([options.pool.query('SELECT 1'), timeout]);
      } finally {
        clearTimeout(timer);
      }
      return { status: 'ready', service: 'core-services' };
    } catch {
      return reply.status(503).send({ status: 'not_ready', service: 'core-services' });
    }
  });

  // Prometheus scrape target on the internal network only: the gateway has no route for it.
  app.get('/metrics', async (_request, reply) =>
    reply.type('text/plain; version=0.0.4').send(metrics.render()),
  );
  app.addHook('onResponse', async (request, reply) => {
    // routeOptions.url is the route pattern; unmatched requests collapse into one label.
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    metrics.observeRequest(request.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });

  // Public routes.
  app.register(authRoutes, { prefix: '/api/v1/auth', deps });

  // Payment provider callback: no JWT; authenticated by an HMAC over the raw body.
  app.register(paymentRoutes, { prefix: '/api/v1/payments', deps });
  app.register(billingCallbackRoutes, { prefix: '/api/v1/billing/payments', deps });

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
      await scope.register(billingRoutes, { prefix: '/billing', deps });
      await scope.register(adminRoutes, { prefix: '/admin', deps });
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
