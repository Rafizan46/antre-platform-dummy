import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const SECRET = 'a-valid-secret-of-at-least-32-characters-long';
const TOKEN = 'a-valid-service-token-of-at-least-32-chars';
const PAYMENT_SECRET = 'a-valid-payment-secret-of-at-least-32-chars';
const REDIS_URL = 'redis://127.0.0.1:6379';
const RABBITMQ_URL = 'amqp://user:pass@127.0.0.1:5672';
const BASE = {
  DATABASE_APP_URL: 'postgres://x',
  JWT_SECRET: SECRET,
  WA_CHANNEL_SERVICE_TOKEN: TOKEN,
  PAYMENT_CALLBACK_SECRET: PAYMENT_SECRET,
  REDIS_URL,
  RABBITMQ_URL,
};

describe('loadConfig', () => {
  it('reads a valid configuration with defaults for host and port', () => {
    expect(loadConfig(BASE)).toEqual({
      databaseUrl: 'postgres://x',
      jwtSecret: SECRET,
      waChannelToken: TOKEN,
      redisUrl: REDIS_URL,
      paymentCallbackSecret: PAYMENT_SECRET,
      rabbitmqUrl: RABBITMQ_URL,
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
    const { PAYMENT_CALLBACK_SECRET, REDIS_URL: redis, ...rest } = BASE;
    expect(PAYMENT_CALLBACK_SECRET && redis).toBeTruthy();
    expect(() => loadConfig({ ...rest, REDIS_URL })).toThrow('PAYMENT_CALLBACK_SECRET');
    expect(() => loadConfig({ ...rest, PAYMENT_CALLBACK_SECRET: PAYMENT_SECRET })).toThrow(
      'REDIS_URL',
    );
  });

  it('requires a redis:// or rediss:// URL without echoing it', () => {
    const bad = 'http://secret-host:6379';
    try {
      loadConfig({ ...BASE, REDIS_URL: bad });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('REDIS_URL');
      expect((error as Error).message).not.toContain(bad);
    }
    expect(loadConfig({ ...BASE, REDIS_URL: 'rediss://cache:6380' }).redisUrl).toBe(
      'rediss://cache:6380',
    );
  });

  it('requires an amqp:// or amqps:// RABBITMQ_URL without echoing it', () => {
    const { RABBITMQ_URL: rabbit, ...withoutRabbit } = BASE;
    expect(rabbit).toBeTruthy();
    expect(() => loadConfig(withoutRabbit)).toThrow('RABBITMQ_URL');
    const bad = 'http://user:secret-pass@broker:5672';
    try {
      loadConfig({ ...BASE, RABBITMQ_URL: bad });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('RABBITMQ_URL');
      expect((error as Error).message).not.toContain('secret-pass');
    }
    expect(loadConfig({ ...BASE, RABBITMQ_URL: 'amqps://broker:5671' }).rabbitmqUrl).toBe(
      'amqps://broker:5671',
    );
  });

  it('rejects a short secret or token without echoing it', () => {
    const short = 'short-secret-value';
    for (const name of ['JWT_SECRET', 'WA_CHANNEL_SERVICE_TOKEN', 'PAYMENT_CALLBACK_SECRET']) {
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
    const paymentSecret = 'dev-only-payment-callback-secret-not-for-prod-01';
    expect(() =>
      loadConfig({ ...BASE, PAYMENT_CALLBACK_SECRET: paymentSecret, NODE_ENV: 'production' }),
    ).toThrow('production');
    const dev = { ...BASE, JWT_SECRET: secret, WA_CHANNEL_SERVICE_TOKEN: token };
    expect(loadConfig({ ...dev, NODE_ENV: 'development' }).jwtSecret).toBe(secret);
    expect(loadConfig(dev).waChannelToken).toBe(token);
  });
});
