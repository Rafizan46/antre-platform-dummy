// WA Channel Service HTTP surface (spec sections 5.1, 8):
//   GET  /healthz                       liveness
//   GET  /readyz                        200 when broker, consumer, and Redis are ready, else 503
//   GET  /metrics                       Prometheus text format
//   GET  /api/v1/channels/wa/webhook    Meta subscription verification
//   POST /api/v1/channels/wa/webhook    Meta notifications (signed)
// The Fastify request logger is off: URLs of the verification carry the verify token and the
// service logs only masked phone numbers itself.
import Fastify from 'fastify';

import type { Metrics } from './metrics.js';
import { webhookRoutes, type WebhookDeps } from './webhook/routes.js';

export interface Readiness {
  /** Named checks, e.g. { broker: true, consumer: false, redis: true }. */
  checks(): Record<string, boolean>;
}

export interface AppDeps {
  webhook: WebhookDeps;
  readiness: Readiness;
  metrics: Metrics;
}

export const WEBHOOK_PREFIX = '/api/v1/channels/wa';

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ status: 'ok', service: 'wa-channel' }));

  app.get('/readyz', async (_request, reply) => {
    const checks = deps.readiness.checks();
    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not ready', checks });
  });

  app.get('/metrics', async (_request, reply) =>
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(deps.metrics.render()),
  );

  app.register(webhookRoutes, { prefix: WEBHOOK_PREFIX, deps: deps.webhook });

  app.setNotFoundHandler((_request, reply) =>
    reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Sumber daya tidak ditemukan.' } }),
  );

  return app;
}
