// Creates a fresh test database (bootstrap + migrations) and clears the test keys of the Redis test
// database before the integration tests; removes them afterwards. The dev database and Redis
// database 0 are never touched.
import {
  bootstrapRoles,
  databaseUrls,
  dropDatabase,
  migrate,
  recreateDatabase,
  type DatabaseUrls,
} from '@antre/db/testing';
import { createClient } from '@redis/client';
import type { TestProject } from 'vitest/node';

const TEST_DATABASE = 'antre_it_rt';
/** Redis logical database of these tests (dev uses 0, the WA tests 13). */
const TEST_REDIS_DB = 12;

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: DatabaseUrls;
    redisUrl: string;
  }
}

function testRedisUrl(): string {
  const value = process.env.REDIS_URL;
  if (!value)
    throw new Error('REDIS_URL is not set; run the tests with "pnpm rt:test:integration".');
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`REDIS_URL must point to 127.0.0.1 or localhost, got ${url.hostname}.`);
  }
  url.pathname = `/${TEST_REDIS_DB}`;
  return url.toString();
}

async function clearRedisKeys(): Promise<void> {
  const client = createClient({ url: testRedisUrl() });
  client.on('error', () => undefined);
  await client.connect();
  try {
    for (const pattern of ['rt:*', 'lock:slot:*']) {
      for await (const keys of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (keys.length > 0) await client.del(keys);
      }
    }
  } finally {
    await client.close();
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await recreateDatabase(TEST_DATABASE);
  const urls = databaseUrls(TEST_DATABASE);
  await bootstrapRoles(urls);
  await migrate(urls, 'up');
  await clearRedisKeys();

  project.provide('databaseUrls', urls);
  project.provide('redisUrl', testRedisUrl());

  return async () => {
    await dropDatabase(TEST_DATABASE);
    await clearRedisKeys();
  };
}
