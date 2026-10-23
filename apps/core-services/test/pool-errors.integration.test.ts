import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { handlePoolErrors } from '../src/db/pool-errors.js';

const appUrl = process.env.DATABASE_APP_URL!;
const adminUrl = process.env.DATABASE_ADMIN_URL!;

describe('pool error handling', () => {
  const pool = new pg.Pool({ connectionString: appUrl, max: 2 });
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  const warn = vi.fn();
  handlePoolErrors(pool, 'app', () => ({ warn }));

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it('survives the server terminating idle connections and recovers', async () => {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    client.release(); // idle in the pool
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);

    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5000 });
    expect(warn.mock.calls[0]![1]).toBe('idle database connection error');

    const result = await pool.query('SELECT 1 AS ok');
    expect(result.rows[0]).toEqual({ ok: 1 });
  });
});
