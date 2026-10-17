// Creates a fresh test database (bootstrap + migrations) before the integration tests and drops
// it afterwards. The dev database itself is never touched.
import {
  bootstrapRoles,
  databaseUrls,
  dropDatabase,
  migrate,
  recreateDatabase,
  type DatabaseUrls,
} from '@antre/db/testing';
import type { TestProject } from 'vitest/node';

const TEST_DATABASE = 'antre_it_core';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: DatabaseUrls;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await recreateDatabase(TEST_DATABASE);
  const urls = databaseUrls(TEST_DATABASE);
  await bootstrapRoles(urls);
  await migrate(urls, 'up');
  project.provide('databaseUrls', urls);

  return async () => {
    await dropDatabase(TEST_DATABASE);
  };
}
