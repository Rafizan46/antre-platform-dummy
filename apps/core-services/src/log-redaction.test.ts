import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { InMemorySlotLock } from './booking/slot-lock.js';
import { maskPhone, redactUrl } from './log-redaction.js';

const PHONE = '6281234567890';

describe('redactUrl', () => {
  it('masks customer_phone and keeps the path and other parameters', () => {
    expect(
      redactUrl(`/internal/v1/queues/tickets/active?location_id=abc&customer_phone=${PHONE}`),
    ).toBe('/internal/v1/queues/tickets/active?location_id=abc&customer_phone=628******7890');
    expect(redactUrl(`/x?customer%5Fphone=%2B${PHONE}`)).not.toContain(PHONE);
    expect(redactUrl('/healthz')).toBe('/healthz');
    expect(redactUrl('/x?flag&customer_phone=%E0%A4')).toBe('/x?flag&customer_phone=******');
    expect(maskPhone(PHONE)).toBe('628******7890');
  });
});

describe('request log', () => {
  it('never contains a full phone number from an /internal/v1 query string', async () => {
    const lines: string[] = [];
    const pool = new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/x' });
    const app = buildApp({
      pool,
      jwtSecret: 'a-valid-secret-of-at-least-32-characters-long',
      waChannelToken: 'a-valid-service-token-of-at-least-32-chars',
      slotLock: new InMemorySlotLock(),
      paymentCallbackSecret: 'a-valid-payment-secret-of-at-least-32-chars',
      logger: { stream: { write: (line: string) => lines.push(line) } },
    });
    try {
      // Answered 401 by the token check before any database access; the request is still logged.
      for (const url of [
        `/internal/v1/customers/active-items?customer_phone=${PHONE}`,
        `/internal/v1/bookings/active?location_id=x&customer_phone=${PHONE}`,
      ]) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: 'Bearer wrong' },
        });
        expect(response.statusCode).toBe(401);
      }
    } finally {
      await app.close();
      await pool.end();
    }
    const log = lines.join('\n');
    expect(log).toContain('incoming request');
    expect(log).toContain('customer_phone=628******7890');
    expect(log).not.toContain(PHONE);
  });
});
