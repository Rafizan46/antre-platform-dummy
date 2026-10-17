// Worker configuration read from the environment. Error messages never contain secret values.
import { DEFAULT_RETRY_DELAYS_MS, MAX_RETRIES } from '@antre/messaging';

import { isLogLevel, type LogLevel } from './logger.js';

export type WhatsAppAdapterKind = 'sandbox' | 'meta';

export interface MetaCloudConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  baseUrl: string;
}

export interface WorkerConfig {
  databaseUrl: string;
  rabbitmqUrl: string;
  adapter: WhatsAppAdapterKind;
  /** Present when adapter = meta. */
  meta: MetaCloudConfig | null;
  /** Language code of the approved WhatsApp templates. */
  templateLanguage: string;
  prefetch: number;
  /** Delay before retry 1, 2, and 3. */
  retryDelaysMs: number[];
  host: string;
  port: number;
  logLevel: LogLevel;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3100;
const DEFAULT_PREFETCH = 10;
const DEFAULT_META_API_VERSION = 'v23.0';
const DEFAULT_META_BASE_URL = 'https://graph.facebook.com';

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

function readRabbitmqUrl(value: string | undefined): string {
  if (!value) throw new Error('RABBITMQ_URL is not set');
  if (!value.startsWith('amqp://') && !value.startsWith('amqps://')) {
    throw new Error('RABBITMQ_URL must start with amqp:// or amqps://');
  }
  return value;
}

function readRetryDelays(value: string | undefined): number[] {
  if (value === undefined) return [...DEFAULT_RETRY_DELAYS_MS];
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== MAX_RETRIES) {
    throw new Error(`NOTIFICATION_RETRY_DELAYS_MS must list ${MAX_RETRIES} delays`);
  }
  return parts.map((part) =>
    readInteger('NOTIFICATION_RETRY_DELAYS_MS', part, 1, 24 * 60 * 60 * 1000),
  );
}

function readMeta(env: NodeJS.ProcessEnv): MetaCloudConfig {
  const accessToken = present(env.META_WA_ACCESS_TOKEN);
  const phoneNumberId = present(env.META_WA_PHONE_NUMBER_ID);
  if (!accessToken) throw new Error('META_WA_ACCESS_TOKEN is not set (WA_ADAPTER=meta)');
  if (!phoneNumberId || !/^[0-9]+$/.test(phoneNumberId)) {
    throw new Error(
      'META_WA_PHONE_NUMBER_ID must be the numeric phone number id (WA_ADAPTER=meta)',
    );
  }
  const apiVersion = present(env.META_WA_API_VERSION) ?? DEFAULT_META_API_VERSION;
  if (!/^v[0-9]+\.[0-9]+$/.test(apiVersion)) {
    throw new Error('META_WA_API_VERSION must look like v23.0');
  }
  const baseUrl = present(env.META_WA_API_BASE_URL) ?? DEFAULT_META_BASE_URL;
  if (!baseUrl.startsWith('https://') && env.NODE_ENV === 'production') {
    throw new Error('META_WA_API_BASE_URL must use https in production');
  }
  return { accessToken, phoneNumberId, apiVersion, baseUrl: baseUrl.replace(/\/+$/, '') };
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const databaseUrl = present(env.DATABASE_APP_URL);
  if (!databaseUrl) throw new Error('DATABASE_APP_URL is not set');
  const rabbitmqUrl = readRabbitmqUrl(present(env.RABBITMQ_URL));

  const adapterValue = present(env.WA_ADAPTER) ?? 'sandbox';
  if (adapterValue !== 'sandbox' && adapterValue !== 'meta') {
    throw new Error('WA_ADAPTER must be sandbox or meta');
  }

  const templateLanguage = present(env.WA_TEMPLATE_LANGUAGE) ?? 'id';
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(templateLanguage)) {
    throw new Error('WA_TEMPLATE_LANGUAGE must be a WhatsApp language code such as id or en_US');
  }

  const logLevel = present(env.LOG_LEVEL) ?? 'info';
  if (!isLogLevel(logLevel))
    throw new Error('LOG_LEVEL must be debug, info, warn, error, or silent');

  const port = present(env.NOTIFICATION_WORKER_PORT);
  const prefetch = present(env.NOTIFICATION_PREFETCH);

  return {
    databaseUrl,
    rabbitmqUrl,
    adapter: adapterValue,
    meta: adapterValue === 'meta' ? readMeta(env) : null,
    templateLanguage,
    prefetch:
      prefetch === undefined
        ? DEFAULT_PREFETCH
        : readInteger('NOTIFICATION_PREFETCH', prefetch, 1, 100),
    retryDelaysMs: readRetryDelays(present(env.NOTIFICATION_RETRY_DELAYS_MS)),
    host: present(env.NOTIFICATION_WORKER_HOST) ?? DEFAULT_HOST,
    port:
      port === undefined ? DEFAULT_PORT : readInteger('NOTIFICATION_WORKER_PORT', port, 1, 65535),
    logLevel,
  };
}
