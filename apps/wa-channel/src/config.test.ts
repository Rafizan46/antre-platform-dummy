import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { maskPhone } from './logger.js';

const BASE = {
  WA_VERIFY_TOKEN: 'dev-only-wa-verify-token-0001',
  WA_APP_SECRET: 'dev-only-wa-app-secret-not-for-production-01',
  WA_CHANNEL_SERVICE_TOKEN: 'dev-only-wa-channel-token-not-for-production-01',
  CORE_SERVICES_URL: 'http://127.0.0.1:3000/',
  REDIS_URL: 'redis://127.0.0.1:36379',
  RABBITMQ_URL: 'amqp://antre:secret-pass@127.0.0.1:35672',
};

describe('loadConfig', () => {
  it('reads a valid configuration with the spec defaults', () => {
    expect(loadConfig(BASE)).toEqual({
      verifyToken: BASE.WA_VERIFY_TOKEN,
      appSecret: BASE.WA_APP_SECRET,
      serviceToken: BASE.WA_CHANNEL_SERVICE_TOKEN,
      coreServicesUrl: 'http://127.0.0.1:3000',
      coreTimeoutMs: 5000,
      redisUrl: BASE.REDIS_URL,
      rabbitmqUrl: BASE.RABBITMQ_URL,
      phoneNumberId: null,
      sessionTtlSeconds: 1800,
      rateLimitPerMinute: 20,
      prefetch: 10,
      retryDelaysMs: [5000, 25000, 125000],
      host: '127.0.0.1',
      port: 3200,
      logLevel: 'info',
    });
  });

  it('treats empty values as unset and reads the optional settings', () => {
    const config = loadConfig({
      ...BASE,
      META_WA_PHONE_NUMBER_ID: '',
      WA_SESSION_TTL_SECONDS: '60',
      WA_INBOUND_RETRY_DELAYS_MS: '100, 200,300',
      WA_CHANNEL_PORT: '3999',
    });
    expect(config.phoneNumberId).toBeNull();
    expect(config.sessionTtlSeconds).toBe(60);
    expect(config.retryDelaysMs).toEqual([100, 200, 300]);
    expect(config.port).toBe(3999);
  });

  it('rejects missing or invalid values without echoing secrets', () => {
    expect(() => loadConfig({ ...BASE, WA_APP_SECRET: undefined })).toThrow(
      'WA_APP_SECRET is not set',
    );
    expect(() => loadConfig({ ...BASE, WA_VERIFY_TOKEN: 'short' })).toThrow('WA_VERIFY_TOKEN');
    expect(() => loadConfig({ ...BASE, CORE_SERVICES_URL: 'ftp://core' })).toThrow(
      'CORE_SERVICES_URL',
    );
    expect(() => loadConfig({ ...BASE, REDIS_URL: 'http://redis' })).toThrow('REDIS_URL');
    expect(() => loadConfig({ ...BASE, META_WA_PHONE_NUMBER_ID: 'abc' })).toThrow(
      'META_WA_PHONE_NUMBER_ID',
    );
    expect(() => loadConfig({ ...BASE, WA_INBOUND_RETRY_DELAYS_MS: '1,2' })).toThrow(
      'WA_INBOUND_RETRY_DELAYS_MS',
    );
    expect(() => loadConfig({ ...BASE, LOG_LEVEL: 'loud' })).toThrow('LOG_LEVEL');
    try {
      loadConfig({ ...BASE, RABBITMQ_URL: 'http://antre:secret-pass@broker' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('RABBITMQ_URL');
      expect((error as Error).message).not.toContain('secret-pass');
    }
  });

  it('refuses dev-only placeholders in production', () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production' })).toThrow('dev-only placeholder');
  });
});

describe('maskPhone', () => {
  it('keeps only the country prefix and the last 4 digits', () => {
    expect(maskPhone('6281234567890')).toBe('628******7890');
    expect(maskPhone('123')).toBe('***');
  });
});
