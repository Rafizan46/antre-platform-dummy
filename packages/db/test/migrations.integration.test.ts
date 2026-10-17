// Migration round trip in its own database: up from zero, down to zero, and up again.
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import {
  bootstrapRoles,
  databaseUrls,
  dropDatabase,
  migrate,
  recreateDatabase,
} from './database.js';

const ROUND_TRIP_DATABASE = 'antre_it_roundtrip';
const MIGRATIONS = ['1792195200000_core-schema', '1792195260000_definer-functions'];

async function countObjects(adminUrl: string): Promise<{ tables: number; functions: number }> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ tables: number; functions: number }>(
      `SELECT
         (SELECT count(*)::int FROM pg_tables
          WHERE schemaname = 'public' AND tablename NOT LIKE 'pgmigrations%') AS tables,
         (SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'public'::regnamespace) AS functions`,
    );
    return rows[0] ?? { tables: -1, functions: -1 };
  } finally {
    await client.end();
  }
}

describe('migrations', () => {
  afterAll(async () => {
    await dropDatabase(ROUND_TRIP_DATABASE);
  });

  it('apply from zero, roll back completely, and apply again', async () => {
    await recreateDatabase(ROUND_TRIP_DATABASE);
    const urls = databaseUrls(ROUND_TRIP_DATABASE);
    await bootstrapRoles(urls);

    expect(await migrate(urls, 'up')).toEqual(MIGRATIONS);
    expect(await countObjects(urls.admin)).toEqual({ tables: 14, functions: 7 });

    expect(await migrate(urls, 'down')).toEqual([...MIGRATIONS].reverse());
    expect(await countObjects(urls.admin)).toEqual({ tables: 0, functions: 0 });

    expect(await migrate(urls, 'up')).toEqual(MIGRATIONS);
    expect(await countObjects(urls.admin)).toEqual({ tables: 14, functions: 7 });
    expect(await migrate(urls, 'up')).toEqual([]);
  });
});
