// WA Channel Service: Meta webhook and conversation engine (spec section 5.1). Skeleton only: business routes are added in later workstreams.
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();

  app.get('/healthz', async () => ({ status: 'ok', service: 'wa-channel' }));

  return app;
}
