// Database lifecycle helpers shared by the integration global setup and the migration
// round-trip test. Connection URLs come from .env.example (loaded by the npm script) or the
// environment; every database created here is dropped again by the caller.
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

const BOOTSTRAP_DIR = fileURLToPath(new URL('../bootstrap', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface DatabaseUrls {
  admin: string;
  migrator: string;
  app: string;
  platformAdmin: string;
}

function readLocalUrl(envName: string): URL {
  const value = process.env[envName];
  if (!value) {
    throw new Error(`${envName} is not set; run the tests with "pnpm db:test:integration".`);
  }
  const url = new URL(value);
  // These helpers drop databases, so they refuse to touch anything but a local server.
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`${envName} must point to 127.0.0.1 or localhost, got ${url.hostname}.`);
  }
  return url;
}

function withDatabase(envName: string, databaseName: string): string {
  const url = readLocalUrl(envName);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** Connection URLs of every role, pointed at `databaseName`. */
export function databaseUrls(databaseName: string): DatabaseUrls {
  return {
    admin: withDatabase('DATABASE_ADMIN_URL', databaseName),
    migrator: withDatabase('DATABASE_MIGRATOR_URL', databaseName),
    app: withDatabase('DATABASE_APP_URL', databaseName),
    platformAdmin: withDatabase('DATABASE_PLATFORM_ADMIN_URL', databaseName),
  };
}

async function onMaintenanceDatabase(sql: string): Promise<void> {
  const client = new pg.Client({
    connectionString: withDatabase('DATABASE_ADMIN_URL', 'postgres'),
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(databaseName: string): Promise<void> {
  await onMaintenanceDatabase(
    `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(databaseName)} WITH (FORCE)`,
  );
}

export async function recreateDatabase(databaseName: string): Promise<void> {
  await dropDatabase(databaseName);
  await onMaintenanceDatabase(`CREATE DATABASE ${pg.escapeIdentifier(databaseName)}`);
}

const silent = (): void => undefined;

/** Applies the dev role bootstrap (superuser) to the database of `urls`. */
export async function bootstrapRoles(urls: DatabaseUrls): Promise<void> {
  await runner({
    databaseUrl: urls.admin,
    dir: BOOTSTRAP_DIR,
    migrationsTable: 'pgmigrations_bootstrap',
    schema: 'public',
    direction: 'up',
    log: silent,
  });
}

/** Runs every pending migration (`up`) or rolls every applied one back (`down`) as antre_migrator. */
export async function migrate(urls: DatabaseUrls, direction: 'up' | 'down'): Promise<string[]> {
  const applied = await runner({
    databaseUrl: urls.migrator,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    schema: 'public',
    direction,
    count: Number.POSITIVE_INFINITY,
    log: silent,
  });
  return applied.map((migration) => migration.name);
}
