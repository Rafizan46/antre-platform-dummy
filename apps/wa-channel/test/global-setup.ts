// Creates a fresh test database (bootstrap + migrations) and a RabbitMQ vhost, and clears the
// test keys of the Redis test database, before the integration tests; removes them afterwards.
// The dev database, the dev vhost "/", and Redis database 0 are never touched.
import {
  bootstrapRoles,
  databaseUrls,
  dropDatabase,
  migrate,
  recreateDatabase,
  type DatabaseUrls,
} from '@antre/db/testing';
import type { TestProject } from 'vitest/node';

import {
  TEST_VHOST,
  clearRedisKeys,
  createVhost,
  deleteVhost,
  testRedisUrl,
  vhostUrl,
} from './broker.js';

const TEST_DATABASE = 'antre_it_wa';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: DatabaseUrls;
    amqpUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await recreateDatabase(TEST_DATABASE);
  const urls = databaseUrls(TEST_DATABASE);
  await bootstrapRoles(urls);
  await migrate(urls, 'up');

  await deleteVhost(TEST_VHOST);
  await createVhost(TEST_VHOST);
  await clearRedisKeys();

  project.provide('databaseUrls', urls);
  project.provide('amqpUrl', vhostUrl(TEST_VHOST));
  project.provide('redisUrl', testRedisUrl());

  return async () => {
    await dropDatabase(TEST_DATABASE);
    await deleteVhost(TEST_VHOST);
    await clearRedisKeys();
  };
}
