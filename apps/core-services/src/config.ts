// Service configuration read from the environment. Error messages never contain secret values.

export interface CoreConfig {
  databaseUrl: string;
  jwtSecret: string;
  /** Static service token of the WhatsApp Channel Service for /internal/v1. */
  waChannelToken: string;
  /** Redis for the booking slot locks (redis:// or rediss://). */
  redisUrl: string;
  /** HMAC secret that signs the QRIS payment callback (spec section 7.4). */
  paymentCallbackSecret: string;
  host: string;
  port: number;
}

const MIN_SECRET_LENGTH = 32;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (env.NODE_ENV === 'production' && value.startsWith('dev-only')) {
    throw new Error(`${name} must not be a dev-only placeholder in production`);
  }
  return value;
}

function readRedisUrl(value: string | undefined): string {
  if (!value) {
    throw new Error('REDIS_URL is not set');
  }
  if (!value.startsWith('redis://') && !value.startsWith('rediss://')) {
    throw new Error('REDIS_URL must start with redis:// or rediss://');
  }
  return value;
}

function readPort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!/^[0-9]+$/.test(value) || port < 1 || port > 65535) {
    throw new Error('CORE_SERVICES_PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv): CoreConfig {
  const databaseUrl = env.DATABASE_APP_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_APP_URL is not set');
  }

  const jwtSecret = readSecret(env, 'JWT_SECRET');
  const waChannelToken = readSecret(env, 'WA_CHANNEL_SERVICE_TOKEN');
  const paymentCallbackSecret = readSecret(env, 'PAYMENT_CALLBACK_SECRET');
  const redisUrl = readRedisUrl(env.REDIS_URL);

  return {
    databaseUrl,
    jwtSecret,
    waChannelToken,
    redisUrl,
    paymentCallbackSecret,
    host: env.CORE_SERVICES_HOST || DEFAULT_HOST,
    port: readPort(env.CORE_SERVICES_PORT),
  };
}
