import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { handlePoolErrors } from './pool-errors.js';

describe('handlePoolErrors', () => {
  it('logs a pool error as a warning instead of letting it crash the process', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://u:secret@127.0.0.1:1/x' });
    const warn = vi.fn();
    handlePoolErrors(pool, 'app', () => ({ warn }));

    expect(() =>
      pool.emit('error', new Error('terminating connection due to administrator command')),
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      { pool: 'app', err: { message: 'terminating connection due to administrator command' } },
      'idle database connection error',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    await pool.end();
  });
});
