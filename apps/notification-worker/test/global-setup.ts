// Creates a fresh test database (bootstrap + migrations) and a RabbitMQ vhost before the
// integration tests and drops both afterwards. The dev database and the dev vhost are never touched.
import {
  bootstrapRoles,
  databaseUrls,
  dropDatabase,
  migrate,
  recreateDatabase,
  type DatabaseUrls,
} from '@antre/db/testing';
import type { TestProject } from 'vitest/node';

import { LATE_VHOST, TEST_VHOST, createVhost, deleteVhost, vhostUrl } from './broker.js';

const TEST_DATABASE = 'antre_it_notif';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: DatabaseUrls;
    amqpUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await recreateDatabase(TEST_DATABASE);
  const urls = databaseUrls(TEST_DATABASE);
  await bootstrapRoles(urls);
  await migrate(urls, 'up');

  await deleteVhost(TEST_VHOST);
  await deleteVhost(LATE_VHOST);
  await createVhost(TEST_VHOST);

  project.provide('databaseUrls', urls);
  project.provide('amqpUrl', vhostUrl(TEST_VHOST));

  return async () => {
    await dropDatabase(TEST_DATABASE);
    await deleteVhost(TEST_VHOST);
    await deleteVhost(LATE_VHOST);
  };
}
