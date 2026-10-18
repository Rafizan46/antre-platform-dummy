// Static checks on the SQL migrations, without a database: the RLS and SECURITY DEFINER rules
// of spec section 6.1 must not regress silently. Database behaviour is covered by the
// *.integration.test.ts files.
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

const TENANT_TABLES = [
  'tenants',
  'users',
  'locations',
  'operating_hours',
  'resources',
  'services',
  'service_resources',
  'ticket_counters',
  'queue_tickets',
  'bookings',
  'notification_logs',
  'subscriptions',
  'usage_counters',
];

const DEFINER_FUNCTIONS = [
  'app_auth_find_user',
  'app_resolve_location',
  'app_find_active_by_phone',
  'app_wa_update_delivery_status',
  'app_due_booking_holds',
  'app_due_booking_reminders',
  'app_due_subscriptions',
];

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const sources = files.map((name) => readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8'));
const upSql = sources.map((sql) => sql.split(/^-- Down Migration$/m)[0] ?? '').join('\n');

describe('migration files', () => {
  it('use node-pg-migrate SQL files with an up section followed by a down section', () => {
    expect(files.length).toBeGreaterThan(0);
    files.forEach((name, index) => {
      expect(name).toMatch(/^\d{13}_[a-z0-9-]+\.sql$/);
      const sql = sources[index] ?? '';
      expect(sql.startsWith('-- Up Migration\n')).toBe(true);
      expect(sql.match(/^-- Down Migration$/gm)).toHaveLength(1);
    });
  });

  it('create the 13 tenant-dependent tables plus the global plans table', () => {
    const created = [...upSql.matchAll(/^CREATE TABLE (\w+) \(/gm)].map((match) => match[1]);
    expect(created.sort()).toEqual([...TENANT_TABLES, 'plans'].sort());
  });

  it.each(TENANT_TABLES)('enable and force RLS with a tenant_isolation policy on %s', (table) => {
    expect(upSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    expect(upSql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    expect(upSql).toContain(
      `CREATE POLICY tenant_isolation ON ${table}\n    FOR ALL TO antre_app\n`,
    );
  });

  it('keep plans global (no RLS)', () => {
    expect(upSql).not.toMatch(/ALTER TABLE plans (ENABLE|FORCE)/);
  });

  it('leave roles to the database administrator and grant nothing to PUBLIC', () => {
    expect(upSql).not.toMatch(/\b(CREATE|ALTER|DROP) ROLE\b/);
    expect(upSql).not.toMatch(/\bTO PUBLIC\b/);
  });

  it('define exactly the closed list of SECURITY DEFINER functions', () => {
    const created = [...upSql.matchAll(/^CREATE FUNCTION (\w+)\(/gm)].map((match) => match[1]);
    expect(created.sort()).toEqual([...DEFINER_FUNCTIONS].sort());
    expect(upSql.match(/^LANGUAGE \w+ \w+ SECURITY DEFINER$/gm)).toHaveLength(
      DEFINER_FUNCTIONS.length,
    );
  });

  it.each(DEFINER_FUNCTIONS)('apply the mandatory definer pattern to %s', (name) => {
    const start = upSql.indexOf(`CREATE FUNCTION ${name}(`);
    const next = upSql.indexOf('CREATE FUNCTION', start + 1);
    const block = upSql.slice(start, next === -1 ? undefined : next);
    expect(block).toContain('SECURITY DEFINER\nSET search_path = pg_catalog, public, pg_temp\n');

    const lines = block.split('\n');
    const lineOf = (prefix: string, suffix: string): number =>
      lines.findIndex((line) => line.startsWith(prefix) && line.endsWith(suffix));
    const revoke = lineOf(`REVOKE ALL ON FUNCTION ${name}(`, ') FROM PUBLIC;');
    const grant = lineOf(`GRANT EXECUTE ON FUNCTION ${name}(`, ') TO antre_app;');
    const owner = lineOf(`ALTER FUNCTION ${name}(`, ') OWNER TO antre_definer;');
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    // Ownership moves last: afterwards antre_migrator (INHERIT FALSE) can no longer change the ACL.
    expect(owner).toBeGreaterThan(grant);
  });
});
