import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEnv } from './env.mjs';

const example = {
  POSTGRES_HOST_PORT: '35432',
  REDIS_HOST_PORT: '36379',
  RABBITMQ_AMQP_HOST_PORT: '35672',
  RABBITMQ_MANAGEMENT_HOST_PORT: '45672',
  DATABASE_APP_URL: 'postgres://antre_app:x@127.0.0.1:35432/antre',
  REDIS_URL: 'redis://127.0.0.1:36379',
  RABBITMQ_URL: 'amqp://antre:y@127.0.0.1:35672',
  RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:45672',
  CORE_SERVICES_HOST: '127.0.0.1',
  CORE_SERVICES_PORT: '3000',
  CORE_SERVICES_URL: 'http://127.0.0.1:3000',
};

test('tanpa override, nilai .env.example dipertahankan', () => {
  const env = resolveEnv({ example });
  assert.equal(env.DATABASE_APP_URL, example.DATABASE_APP_URL);
  assert.equal(env.REDIS_URL, example.REDIS_URL);
  assert.equal(env.RABBITMQ_MANAGEMENT_URL, example.RABBITMQ_MANAGEMENT_URL);
  assert.equal(env.CORE_SERVICES_URL, 'http://127.0.0.1:3000');
});

test('port host dari env proses diteruskan ke URL turunan', () => {
  const env = resolveEnv({
    example,
    processEnv: {
      POSTGRES_HOST_PORT: '56400',
      REDIS_HOST_PORT: '56401',
      RABBITMQ_AMQP_HOST_PORT: '56402',
      RABBITMQ_MANAGEMENT_HOST_PORT: '56403',
      CORE_SERVICES_PORT: '56410',
    },
  });
  assert.equal(env.DATABASE_APP_URL, 'postgres://antre_app:x@127.0.0.1:56400/antre');
  assert.equal(env.REDIS_URL, 'redis://127.0.0.1:56401');
  assert.equal(env.RABBITMQ_URL, 'amqp://antre:y@127.0.0.1:56402');
  assert.equal(env.RABBITMQ_MANAGEMENT_URL, 'http://127.0.0.1:56403');
  assert.equal(env.CORE_SERVICES_URL, 'http://127.0.0.1:56410');
});

test('URL yang diatur eksplisit di .env tidak ditimpa; env proses mengalahkan .env', () => {
  const env = resolveEnv({
    example,
    dotenv: { REDIS_URL: 'redis://redis.lokal:6379', CORE_SERVICES_PORT: '4000' },
    processEnv: { CORE_SERVICES_PORT: '4100', POSTGRES_HOST_PORT: '1' },
  });
  assert.equal(env.REDIS_URL, 'redis://redis.lokal:6379');
  assert.equal(env.CORE_SERVICES_PORT, '4100');
  assert.equal(env.DATABASE_APP_URL, 'postgres://antre_app:x@127.0.0.1:1/antre');
});

test('env proses yang tidak ada di .env.example diabaikan', () => {
  const env = resolveEnv({ example, processEnv: { PATH: '/bin', SECRET_LAIN: 'x' } });
  assert.equal(env.PATH, undefined);
  assert.equal(env.SECRET_LAIN, undefined);
});
