// Unit tests only (no database): static checks on the SQL files. Run by `pnpm -r test` and CI.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.unit.test.ts'],
  },
});
