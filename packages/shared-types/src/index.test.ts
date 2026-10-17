import { describe, expect, it } from 'vitest';

describe('@antre/shared-types', () => {
  it('loads the entry module', async () => {
    await expect(import('./index.js')).resolves.toBeDefined();
  });
});
