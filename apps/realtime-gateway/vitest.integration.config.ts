// Integration tests against real PostgreSQL and Redis with the core services embedded. Run with
// `pnpm rt:test:integration`; never part of `pnpm -r test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
