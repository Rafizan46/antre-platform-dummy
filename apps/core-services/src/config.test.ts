import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const SECRET = 'a-valid-secret-of-at-least-32-characters-long';
const TOKEN = 'a-valid-service-token-of-at-least-32-chars';
const BASE = {
  DATABASE_APP_URL: 'postgres://x',
  JWT_SECRET: SECRET,
  WA_CHANNEL_SERVICE_TOKEN: TOKEN,
};

describe('loadConfig', () => {
  it('reads a valid configuration with defaults for host and port', () => {
    expect(loadConfig(BASE)).toEqual({
      databaseUrl: 'postgres://x',
      jwtSecret: SECRET,
      waChannelToken: TOKEN,
      host: '127.0.0.1',
      port: 3000,
    });
  });

  it('reads host and port', () => {
    const config = loadConfig({
      ...BASE,
      CORE_SERVICES_HOST: '0.0.0.0',
      CORE_SERVICES_PORT: '8080',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
  });

  it('rejects an invalid port', () => {
    for (const port of ['0', '65536', 'abc', '30.5', '-1']) {
      expect(() => loadConfig({ ...BASE, CORE_SERVICES_PORT: port })).toThrow('CORE_SERVICES_PORT');
    }
  });

  it('rejects missing values', () => {
    const { DATABASE_APP_URL, ...withoutUrl } = BASE;
    const { JWT_SECRET, ...withoutSecret } = BASE;
    const { WA_CHANNEL_SERVICE_TOKEN, ...withoutToken } = BASE;
    expect(DATABASE_APP_URL && JWT_SECRET && WA_CHANNEL_SERVICE_TOKEN).toBeTruthy();
    expect(() => loadConfig(withoutUrl)).toThrow('DATABASE_APP_URL');
    expect(() => loadConfig(withoutSecret)).toThrow('JWT_SECRET');
    expect(() => loadConfig({ ...BASE, JWT_SECRET: '' })).toThrow('JWT_SECRET');
    expect(() => loadConfig(withoutToken)).toThrow('WA_CHANNEL_SERVICE_TOKEN');
  });

  it('rejects a short secret or token without echoing it', () => {
    const short = 'short-secret-value';
    for (const name of ['JWT_SECRET', 'WA_CHANNEL_SERVICE_TOKEN']) {
      try {
        loadConfig({ ...BASE, [name]: short });
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toContain(name);
        expect((error as Error).message).not.toContain(short);
      }
    }
  });

  it('rejects dev-only values in production only', () => {
    const secret = 'dev-only-jwt-secret-not-for-production-0001';
    const token = 'dev-only-wa-channel-token-not-for-production-01';
    expect(() => loadConfig({ ...BASE, JWT_SECRET: secret, NODE_ENV: 'production' })).toThrow(
      'production',
    );
    expect(() =>
      loadConfig({ ...BASE, WA_CHANNEL_SERVICE_TOKEN: token, NODE_ENV: 'production' }),
    ).toThrow('production');
    const dev = { ...BASE, JWT_SECRET: secret, WA_CHANNEL_SERVICE_TOKEN: token };
    expect(loadConfig({ ...dev, NODE_ENV: 'development' }).jwtSecret).toBe(secret);
    expect(loadConfig(dev).waChannelToken).toBe(token);
  });
});
