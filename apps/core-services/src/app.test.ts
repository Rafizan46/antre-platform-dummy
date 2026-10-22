import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { InMemorySlotLock } from './booking/slot-lock.js';

// The pool never connects: every request below is answered before any query.
const pool = new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/x' });
const app = buildApp({
  pool,
  jwtSecret: 'a-valid-secret-of-at-least-32-characters-long',
  waChannelToken: 'a-valid-service-token-of-at-least-32-chars',
  slotLock: new InMemorySlotLock(),
  paymentCallbackSecret: 'a-valid-payment-secret-of-at-least-32-chars',
});

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('core-services app', () => {
  it('GET /healthz responds with status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'core-services' });
  });

  it('GET /readyz answers 503 while the database is unreachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', service: 'core-services' });
  });

  it('rejects a protected route without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/users' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
  });

  it('rejects an internal route without or with a wrong service token', async () => {
    const missing = await app.inject({ method: 'GET', url: '/internal/v1/catalog/services' });
    expect(missing.statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'GET',
      url: '/internal/v1/catalog/services',
      headers: { authorization: 'Bearer not-the-service-token' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('checks the service token before the tenant header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/v1/catalog/services',
      headers: { authorization: 'Bearer a-valid-service-token-of-at-least-32-chars' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('answers unknown routes with 404 NOT_FOUND', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('answers malformed JSON on login with 400 VALIDATION_ERROR', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('answers an invalid login body with 400 VALIDATION_ERROR', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /metrics', () => {
  it('exposes request counters and histograms by route pattern, without raw URLs', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/users' });
    await app.inject({ method: 'GET', url: '/no/such/path/user@example.com' });

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain(
      'antre_http_requests_total{method="GET",route="/api/v1/users",status="401"} ',
    );
    expect(response.body).toContain('route="unmatched"');
    expect(response.body).toContain('antre_http_request_duration_seconds_bucket{');
    expect(response.body).toContain('le="+Inf"');
    expect(response.body).toContain('antre_db_pool_connections{pool="app",state="total"}');
    expect(response.body).not.toContain('user@example.com');
    expect(response.body).not.toContain('route="/metrics"');
  });
});
