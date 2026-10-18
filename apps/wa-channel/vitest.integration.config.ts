// Integration tests against real PostgreSQL, Redis, RabbitMQ, and the core services (embedded).
// Run with `pnpm wa:test:integration`; never part of `pnpm -r test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // All files share one database, one Redis database, and one vhost, so they run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
