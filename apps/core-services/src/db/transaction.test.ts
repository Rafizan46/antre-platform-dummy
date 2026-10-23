import { EventEmitter } from 'node:events';

import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { withTransaction } from './transaction.js';

/** A checked-out client whose connection the server drops while `work` runs. */
function fakePool() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('Client has encountered a connection error');
      return { rows: [] };
    }),
    release: vi.fn(),
  });
  const pool = { connect: vi.fn(async () => client) };
  return { pool: pool as unknown as pg.Pool, client };
}

describe('withTransaction', () => {
  it('does not crash when the server drops the checked-out connection, and discards it', async () => {
    const { pool, client } = fakePool();
    await expect(
      withTransaction(pool, 'tenant-1', async () => {
        // Without a listener, emitting 'error' here would throw ERR_UNHANDLED_ERROR (= a crash).
        client.emit('error', new Error('terminating connection due to administrator command'));
        throw new Error('query failed');
      }),
    ).rejects.toThrow('query failed');
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
    expect(client.listenerCount('error')).toBe(0);
  });
});
