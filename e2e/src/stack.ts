// What the global setup tells the tests about the running stack, and small shared helpers.
import { setTimeout as delay } from 'node:timers/promises';

import type { DatabaseUrls } from '@antre/db/testing';
import { inject } from 'vitest';

export interface StackContext {
  coreUrl: string;
  waUrl: string;
  realtimeUrl: string;
  workerUrl: string;
  /** Control endpoint of the harness: POST /broker/cut and /broker/restore. */
  controlUrl: string;
  /** JSON log lines of the notification worker (its sandbox adapter prints every WhatsApp message). */
  workerLog: string;
  coreLog: string;
  databaseUrls: DatabaseUrls;
  secrets: {
    jwt: string;
    serviceToken: string;
    paymentCallback: string;
    waAppSecret: string;
    waVerifyToken: string;
  };
}

export function stack(): StackContext {
  return inject('stack');
}

/** Polls `check` until it returns a value other than undefined/null/false, or fails on timeout. */
export async function eventually<T>(
  description: string,
  check: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Exclude<T, undefined | null | false>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== null && value !== false) {
        return value as Exclude<T, undefined | null | false>;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}${reason}`);
    }
    await delay(intervalMs);
  }
}
