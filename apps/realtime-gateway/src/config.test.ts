import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const BASE = {
  JWT_SECRET: 'dev-only-jwt-secret-not-for-production-0001',
  REDIS_URL: 'redis://127.0.0.1:36379',
};

describe('loadConfig', () => {
  it('applies the defaults', () => {
    expect(loadConfig(BASE)).toMatchObject({
      host: '127.0.0.1',
      port: 3300,
      heartbeatMs: 15_000,
      maxConnectionsPerTenant: 100,
      maxStreamSeconds: 3_600,
      snapshotSize: 50,
      logLevel: 'info',
    });
  });

  it('rejects missing or weak secrets without echoing them', () => {
    expect(() => loadConfig({ REDIS_URL: BASE.REDIS_URL })).toThrow('JWT_SECRET is not set');
    expect(() => loadConfig({ ...BASE, JWT_SECRET: 'short' })).toThrow('at least 32');
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production' })).toThrow('dev-only');
  });

  it('validates the URL and the numbers', () => {
    expect(() => loadConfig({ ...BASE, REDIS_URL: 'http://x' })).toThrow('redis://');
    expect(() => loadConfig({ ...BASE, REALTIME_PORT: '0' })).toThrow('REALTIME_PORT');
    expect(() => loadConfig({ ...BASE, LOG_LEVEL: 'loud' })).toThrow('LOG_LEVEL');
    expect(
      loadConfig({ ...BASE, REALTIME_MAX_CONNECTIONS_PER_TENANT: '5' }).maxConnectionsPerTenant,
    ).toBe(5);
  });
});
