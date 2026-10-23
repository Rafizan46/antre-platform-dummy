// End-to-end customer journeys against the real built services (dist) as child processes.
// Run with `pnpm e2e` from the repository root; never part of `pnpm -r test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.test.ts'],
    globalSetup: ['src/global-setup.ts'],
    // One shared stack (database, vhost, Redis database), so files run one at a time, in name order.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
