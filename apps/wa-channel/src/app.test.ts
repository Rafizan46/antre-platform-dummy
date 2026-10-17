import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

describe('GET /healthz', () => {
  it('responds with status ok', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'wa-channel' });
  });
});
