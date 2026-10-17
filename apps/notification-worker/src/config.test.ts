import { describe, expect, it } from 'vitest';

import { loadWorkerConfig } from './config.js';

const BASE = {
  DATABASE_APP_URL: 'postgres://x',
  RABBITMQ_URL: 'amqp://user:pass@127.0.0.1:5672',
};

describe('loadWorkerConfig', () => {
  it('reads a valid configuration with defaults (sandbox adapter, spec backoff)', () => {
    expect(loadWorkerConfig(BASE)).toEqual({
      databaseUrl: 'postgres://x',
      rabbitmqUrl: 'amqp://user:pass@127.0.0.1:5672',
      adapter: 'sandbox',
      meta: null,
      templateLanguage: 'id',
      prefetch: 10,
      retryDelaysMs: [5000, 25000, 125000],
      host: '127.0.0.1',
      port: 3100,
      logLevel: 'info',
    });
  });

  it('treats empty values as unset (node --env-file placeholders)', () => {
    expect(
      loadWorkerConfig({
        ...BASE,
        WA_ADAPTER: '',
        META_WA_ACCESS_TOKEN: '',
        NOTIFICATION_PREFETCH: '',
      }).adapter,
    ).toBe('sandbox');
  });

  it('reads the Meta Cloud API settings when WA_ADAPTER=meta', () => {
    const config = loadWorkerConfig({
      ...BASE,
      WA_ADAPTER: 'meta',
      META_WA_ACCESS_TOKEN: 'token',
      META_WA_PHONE_NUMBER_ID: '1234567890',
      META_WA_API_BASE_URL: 'https://graph.example.test/',
    });
    expect(config.meta).toEqual({
      accessToken: 'token',
      phoneNumberId: '1234567890',
      apiVersion: 'v23.0',
      baseUrl: 'https://graph.example.test',
    });
    expect(() => loadWorkerConfig({ ...BASE, WA_ADAPTER: 'meta' })).toThrow('META_WA_ACCESS_TOKEN');
    expect(() =>
      loadWorkerConfig({ ...BASE, WA_ADAPTER: 'meta', META_WA_ACCESS_TOKEN: 'secret-token' }),
    ).toThrow('META_WA_PHONE_NUMBER_ID');
  });

  it('rejects invalid values without echoing secrets', () => {
    expect(() => loadWorkerConfig({ RABBITMQ_URL: BASE.RABBITMQ_URL })).toThrow('DATABASE_APP_URL');
    expect(() => loadWorkerConfig({ DATABASE_APP_URL: 'postgres://x' })).toThrow('RABBITMQ_URL');
    try {
      loadWorkerConfig({ ...BASE, RABBITMQ_URL: 'http://user:secret-pass@broker' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('RABBITMQ_URL');
      expect((error as Error).message).not.toContain('secret-pass');
    }
    expect(() => loadWorkerConfig({ ...BASE, WA_ADAPTER: 'twilio' })).toThrow('WA_ADAPTER');
    expect(() => loadWorkerConfig({ ...BASE, NOTIFICATION_PREFETCH: '0' })).toThrow(
      'NOTIFICATION_PREFETCH',
    );
    expect(() => loadWorkerConfig({ ...BASE, NOTIFICATION_WORKER_PORT: '70000' })).toThrow(
      'NOTIFICATION_WORKER_PORT',
    );
    expect(() => loadWorkerConfig({ ...BASE, NOTIFICATION_RETRY_DELAYS_MS: '100,200' })).toThrow(
      'NOTIFICATION_RETRY_DELAYS_MS',
    );
    expect(() => loadWorkerConfig({ ...BASE, LOG_LEVEL: 'loud' })).toThrow('LOG_LEVEL');
    expect(
      loadWorkerConfig({ ...BASE, NOTIFICATION_RETRY_DELAYS_MS: '100, 200,400' }).retryDelaysMs,
    ).toEqual([100, 200, 400]);
  });
});
