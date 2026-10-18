// Realtime SSE Gateway configuration read from the environment. Error messages never contain
// secret values (JWT secret, URLs with credentials).
import { isLogLevel, type LogLevel } from './logger.js';

export interface RealtimeConfig {
  /** HS256 secret shared with the core services (user and KIOSK_DISPLAY tokens). */
  jwtSecret: string;
  redisUrl: string;
  host: string;
  port: number;
  /** SSE comment sent to every stream at this interval (keeps proxies from timing out). */
  heartbeatMs: number;
  /** `retry:` hint for EventSource reconnects. */
  retryMs: number;
  maxConnections: number;
  maxConnectionsPerTenant: number;
  /** A stream ends after this long (or at token expiry); the client reconnects with Last-Event-ID. */
  maxStreamSeconds: number;
  /** A client whose socket buffer exceeds this is dropped (backpressure). */
  maxBufferedBytes: number;
  /** Updates in the snapshot sent to a client without (usable) Last-Event-ID. */
  snapshotSize: number;
  /** Maximum updates replayed after Last-Event-ID; beyond it a snapshot is sent instead. */
  replayLimit: number;
  logLevel: LogLevel;
}

const MIN_SECRET_LENGTH = 32;

function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = present(env[name]);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^[0-9]+$/.test(value) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = present(env[name]);
  if (!value) throw new Error(`${name} is not set`);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (env.NODE_ENV === 'production' && value.startsWith('dev-only')) {
    throw new Error(`${name} must not be a dev-only placeholder in production`);
  }
  return value;
}

function readRedisUrl(value: string | undefined): string {
  if (!value) throw new Error('REDIS_URL is not set');
  if (!value.startsWith('redis://') && !value.startsWith('rediss://')) {
    throw new Error('REDIS_URL must start with redis:// or rediss://');
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): RealtimeConfig {
  const logLevel = present(env.LOG_LEVEL) ?? 'info';
  if (!isLogLevel(logLevel)) {
    throw new Error('LOG_LEVEL must be debug, info, warn, error, or silent');
  }
  return {
    jwtSecret: readSecret(env, 'JWT_SECRET'),
    redisUrl: readRedisUrl(present(env.REDIS_URL)),
    host: present(env.REALTIME_HOST) ?? '127.0.0.1',
    port: readInteger(env, 'REALTIME_PORT', 3300, 1, 65535),
    heartbeatMs: readInteger(env, 'REALTIME_HEARTBEAT_MS', 15_000, 100, 300_000),
    retryMs: readInteger(env, 'REALTIME_RETRY_MS', 3_000, 100, 60_000),
    maxConnections: readInteger(env, 'REALTIME_MAX_CONNECTIONS', 5_000, 1, 1_000_000),
    maxConnectionsPerTenant: readInteger(
      env,
      'REALTIME_MAX_CONNECTIONS_PER_TENANT',
      100,
      1,
      100_000,
    ),
    maxStreamSeconds: readInteger(env, 'REALTIME_MAX_STREAM_SECONDS', 3_600, 1, 86_400),
    maxBufferedBytes: readInteger(env, 'REALTIME_MAX_BUFFERED_BYTES', 262_144, 1_024, 67_108_864),
    snapshotSize: readInteger(env, 'REALTIME_SNAPSHOT_SIZE', 50, 0, 500),
    replayLimit: readInteger(env, 'REALTIME_REPLAY_LIMIT', 200, 1, 500),
    logLevel,
  };
}
