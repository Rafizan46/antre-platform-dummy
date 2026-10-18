// Unit tests only (no Redis, RabbitMQ, or core services): src/**/*.test.ts. Integration tests use
// vitest.integration.config.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
