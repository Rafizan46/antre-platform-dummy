// An idle pooled connection that the server drops (PostgreSQL restart, failover, administrator
// command) emits 'error' on the pool; without a listener Node treats it as uncaught and the process
// dies. The pool discards that connection and opens a new one on demand, so logging is enough.
import type pg from 'pg';

interface WarnLogger {
  warn(object: object, message: string): void;
}

export function handlePoolErrors(pool: pg.Pool, name: string, log: () => WarnLogger): void {
  pool.on('error', (error) => {
    // Only the message: pg errors carry no connection string, and no row data is attached.
    log().warn({ pool: name, err: { message: error.message } }, 'idle database connection error');
  });
}
