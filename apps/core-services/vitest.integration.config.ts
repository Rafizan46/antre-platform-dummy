// Integration tests against a real PostgreSQL (docker-compose.dev.yml or the CI service container).
// Run with `pnpm core:test:integration`; never part of `pnpm -r test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // All files share one test database, so they run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
