import { describe, expect, it } from 'vitest';

describe('@antre/event-contracts', () => {
  it('loads the entry module', async () => {
    await expect(import('./index.js')).resolves.toBeDefined();
  });
});
