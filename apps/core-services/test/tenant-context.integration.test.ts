import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTransaction } from '../src/db/transaction.js';
import { createTestApp, registerTenant, type TestApp } from './helpers.js';

let ctx: TestApp;
// A single connection makes "the next query on the same connection" deterministic.
let singlePool: pg.Pool;

beforeAll(async () => {
  ctx = await createTestApp();
  singlePool = new pg.Pool({ connectionString: ctx.pool.options.connectionString, max: 1 });
});

afterAll(async () => {
  await singlePool.end();
  await ctx.close();
});

describe('tenant context', () => {
  it('connects as antre_app', async () => {
    const result = await ctx.pool.query<{ current_user: string }>('SELECT current_user');
    expect(result.rows[0]?.current_user).toBe('antre_app');
  });

  it('does not leak the tenant context to the next query on the same connection', async () => {
    const tenant = await registerTenant(ctx.app);

    const inside = await withTransaction(singlePool, tenant.tenantId, async (client) => {
      const result = await client.query<{ count: string }>('SELECT count(*) FROM tenants');
      return Number(result.rows[0]?.count);
    });
    expect(inside).toBe(1);

    const after = await singlePool.query<{ setting: string | null; count: string }>(
      `SELECT current_setting('app.current_tenant_id', true) AS setting,
              (SELECT count(*) FROM tenants) AS count`,
    );
    expect([null, '']).toContain(after.rows[0]?.setting);
    expect(Number(after.rows[0]?.count)).toBe(0);
  });

  it('rolls back when the work throws', async () => {
    const tenantId = randomUUID();

    await expect(
      withTransaction(ctx.pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenants (id, name, slug, business_type, admin_wa_phone)
           VALUES ($1, 'Rollback', $2, 'OTHER', '6281234567890')`,
          [tenantId, `rollback-${tenantId.slice(0, 8)}`],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const rows = await withTransaction(
      ctx.pool,
      tenantId,
      async (client) =>
        (await client.query('SELECT id FROM tenants WHERE id = $1', [tenantId])).rows,
    );
    expect(rows).toHaveLength(0);
  });
});
