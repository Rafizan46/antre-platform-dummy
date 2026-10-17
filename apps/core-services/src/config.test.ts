import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const SECRET = 'a-valid-secret-of-at-least-32-characters-long';

describe('loadConfig', () => {
  it('reads a valid configuration', () => {
    expect(loadConfig({ DATABASE_APP_URL: 'postgres://x', JWT_SECRET: SECRET })).toEqual({
      databaseUrl: 'postgres://x',
      jwtSecret: SECRET,
    });
  });

  it('rejects missing values', () => {
    expect(() => loadConfig({ JWT_SECRET: SECRET })).toThrow('DATABASE_APP_URL');
    expect(() => loadConfig({ DATABASE_APP_URL: 'postgres://x' })).toThrow('JWT_SECRET');
    expect(() => loadConfig({ DATABASE_APP_URL: 'postgres://x', JWT_SECRET: '' })).toThrow(
      'JWT_SECRET',
    );
  });

  it('rejects a short secret without echoing it', () => {
    const short = 'short-secret-value';
    try {
      loadConfig({ DATABASE_APP_URL: 'postgres://x', JWT_SECRET: short });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
  });

  it('rejects a dev-only secret in production only', () => {
    const secret = 'dev-only-jwt-secret-not-for-production-0001';
    const env = { DATABASE_APP_URL: 'postgres://x', JWT_SECRET: secret };
    expect(() => loadConfig({ ...env, NODE_ENV: 'production' })).toThrow('production');
    expect(loadConfig({ ...env, NODE_ENV: 'development' }).jwtSecret).toBe(secret);
    expect(loadConfig(env).jwtSecret).toBe(secret);
  });
});
