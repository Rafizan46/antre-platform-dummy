// One transaction per request with the tenant context set for RLS. The tenant id is set with
// set_config(..., true) (the parameterised SET LOCAL), so it ends with the transaction and can
// never leak to the next user of a pooled connection. Session-level SET is forbidden.
import type pg from 'pg';

import { guardCheckedOutClient } from './pool-errors.js';

export async function withTransaction<T>(
  pool: pg.Pool,
  tenantId: string | null,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const unguard = guardCheckedOutClient(client);
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // The connection state is unknown: release with an error so the pool discards it.
      releaseError = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
    }
    throw error;
  } finally {
    unguard();
    client.release(releaseError);
  }
}
