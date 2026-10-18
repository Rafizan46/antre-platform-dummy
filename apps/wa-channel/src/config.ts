// WA Channel Service configuration read from the environment. Error messages never contain
// secret values (verify token, app secret, service token, URLs with credentials).
import { DEFAULT_RETRY_DELAYS_MS, MAX_RETRIES } from '@antre/messaging';

import { isLogLevel, type LogLevel } from './logger.js';

export interface WaChannelConfig {
  /** hub.verify_token of the webhook subscription (FR-WA-02). */
  verifyToken: string;
  /** Meta App Secret: HMAC key of X-Hub-Signature-256. */
  appSecret: string;
  /** Static token for /internal/v1 of the core services (WA_CHANNEL_SERVICE_TOKEN). */
  serviceToken: string;
  /** Base URL of the core services, e.g. http://127.0.0.1:3000 (cluster-internal). */
  coreServicesUrl: string;
  /** Timeout of one call to the core services. */
  coreTimeoutMs: number;
  redisUrl: string;
  rabbitmqUrl: string;
  /** When set, webhook changes for another phone_number_id are ignored. */
  phoneNumberId: string | null;
  /** Conversation session lifetime since the last message (FR-WA-03: 30 minutes). */
  sessionTtlSeconds: number;
  /** Inbound messages per minute per number before replies stop (FR-WA-08: 20). */
  rateLimitPerMinute: number;
  /** wa.inbound messages handled in parallel. */
  prefetch: number;
  /** Delay before retry 1, 2, and 3 of an inbound message. */
  retryDelaysMs: number[];
  host: string;
  port: number;
  logLevel: LogLevel;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3200;
const DEFAULT_PREFETCH = 10;
const DEFAULT_SESSION_TTL_SECONDS = 30 * 60;
const DEFAULT_RATE_LIMIT = 20;
const DEFAULT_CORE_TIMEOUT_MS = 5_000;
const MIN_SERVICE_TOKEN_LENGTH = 32;
const MIN_WEBHOOK_SECRET_LENGTH = 16;

function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function readInteger(name: string, value: string | undefined, min: number, max: number): number {
  const number = Number(value);
  if (value === undefined || !/^[0-9]+$/.test(value) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function readOptionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = present(env[name]);
  return value === undefined ? fallback : readInteger(name, value, min, max);
}

function readSecret(env: NodeJS.ProcessEnv, name: string, minLength: number): string {
  const value = present(env[name]);
  if (!value) throw new Error(`${name} is not set`);
  if (value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`);
  if (env.NODE_ENV === 'production' && value.startsWith('dev-only')) {
    throw new Error(`${name} must not be a dev-only placeholder in production`);
  }
  return value;
}

function readUrl(name: string, value: string | undefined, protocols: string[]): string {
  if (!value) throw new Error(`${name} is not set`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must start with ${protocols.map((p) => `${p}//`).join(' or ')}`);
  }
  return value;
}

function readRetryDelays(value: string | undefined): number[] {
  if (value === undefined) return [...DEFAULT_RETRY_DELAYS_MS];
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== MAX_RETRIES) {
    throw new Error(`WA_INBOUND_RETRY_DELAYS_MS must list ${MAX_RETRIES} delays`);
  }
  return parts.map((part) => readInteger('WA_INBOUND_RETRY_DELAYS_MS', part, 1, 24 * 60 * 60_000));
}

export function loadConfig(env: NodeJS.ProcessEnv): WaChannelConfig {
  const verifyToken = readSecret(env, 'WA_VERIFY_TOKEN', MIN_WEBHOOK_SECRET_LENGTH);
  const appSecret = readSecret(env, 'WA_APP_SECRET', MIN_WEBHOOK_SECRET_LENGTH);
  const serviceToken = readSecret(env, 'WA_CHANNEL_SERVICE_TOKEN', MIN_SERVICE_TOKEN_LENGTH);
  const coreServicesUrl = readUrl('CORE_SERVICES_URL', present(env.CORE_SERVICES_URL), [
    'http:',
    'https:',
  ]).replace(/\/+$/, '');
  const redisUrl = readUrl('REDIS_URL', present(env.REDIS_URL), ['redis:', 'rediss:']);
  const rabbitmqUrl = readUrl('RABBITMQ_URL', present(env.RABBITMQ_URL), ['amqp:', 'amqps:']);

  const phoneNumberId = present(env.META_WA_PHONE_NUMBER_ID) ?? null;
  if (phoneNumberId !== null && !/^[0-9]+$/.test(phoneNumberId)) {
    throw new Error('META_WA_PHONE_NUMBER_ID must be the numeric phone number id');
  }

  const logLevel = present(env.LOG_LEVEL) ?? 'info';
  if (!isLogLevel(logLevel)) {
    throw new Error('LOG_LEVEL must be debug, info, warn, error, or silent');
  }

  return {
    verifyToken,
    appSecret,
    serviceToken,
    coreServicesUrl,
    coreTimeoutMs: readOptionalInteger(
      env,
      'CORE_REQUEST_TIMEOUT_MS',
      DEFAULT_CORE_TIMEOUT_MS,
      100,
      60_000,
    ),
    redisUrl,
    rabbitmqUrl,
    phoneNumberId,
    sessionTtlSeconds: readOptionalInteger(
      env,
      'WA_SESSION_TTL_SECONDS',
      DEFAULT_SESSION_TTL_SECONDS,
      1,
      24 * 60 * 60,
    ),
    rateLimitPerMinute: readOptionalInteger(
      env,
      'WA_RATE_LIMIT_PER_MINUTE',
      DEFAULT_RATE_LIMIT,
      1,
      1000,
    ),
    prefetch: readOptionalInteger(env, 'WA_INBOUND_PREFETCH', DEFAULT_PREFETCH, 1, 100),
    retryDelaysMs: readRetryDelays(present(env.WA_INBOUND_RETRY_DELAYS_MS)),
    host: present(env.WA_CHANNEL_HOST) ?? DEFAULT_HOST,
    port: readOptionalInteger(env, 'WA_CHANNEL_PORT', DEFAULT_PORT, 1, 65535),
    logLevel,
  };
}
