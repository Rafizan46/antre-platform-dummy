// S10 (FR-REALTIME-02): the owner issues and revokes the KIOSK_DISPLAY tokens of a location.
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiRequest,
  bearer,
  createTestApp,
  setupQueueFixture,
  type QueueFixture,
  type TestApp,
} from './helpers.js';

let ctx: TestApp;
let f: QueueFixture;
let other: QueueFixture;

beforeAll(async () => {
  ctx = await createTestApp();
  f = await setupQueueFixture(ctx);
  other = await setupQueueFixture(ctx);
});

afterAll(async () => {
  await ctx.close();
});

describe('POST /api/v1/locations/:id/kiosk-tokens', () => {
  it('issues a 30-day KIOSK_DISPLAY token bound to the tenant and location', async () => {
    const response = await apiRequest(
      ctx.app,
      'POST',
      `/api/v1/locations/${f.locationId}/kiosk-tokens`,
      f.owner,
    );

    expect(response.statusCode).toBe(201);
    const body = response.json<{ token: string; expires_in: number; location_id: string }>();
    expect(body.expires_in).toBe(30 * 24 * 60 * 60);
    expect(body.location_id).toBe(f.locationId);
    const claims = decodeJwt(body.token);
    expect(claims).toMatchObject({
      role: 'KIOSK_DISPLAY',
      tenant_id: f.tenant.tenantId,
      location_id: f.locationId,
      iss: 'antre-auth',
      aud: 'antre-api',
    });
    expect(typeof claims.iat_ms).toBe('number');
  });

  it('is rejected as a user token by the core services', async () => {
    const issued = await apiRequest(
      ctx.app,
      'POST',
      `/api/v1/locations/${f.locationId}/kiosk-tokens`,
      f.owner,
    );
    const kiosk = bearer(issued.json<{ token: string }>().token);

    const response = await apiRequest(ctx.app, 'GET', '/api/v1/locations', kiosk);
    expect(response.statusCode).toBe(401);
  });

  it('is owner-only and limited to the tenant own locations', async () => {
    const url = `/api/v1/locations/${f.locationId}/kiosk-tokens`;
    expect((await apiRequest(ctx.app, 'POST', url, f.caller)).statusCode).toBe(403);
    expect((await apiRequest(ctx.app, 'POST', url, other.owner)).statusCode).toBe(404);
    expect(
      (await apiRequest(ctx.app, 'POST', '/api/v1/locations/not-a-uuid/kiosk-tokens', f.owner))
        .statusCode,
    ).toBe(404);
  });
});

describe('DELETE /api/v1/locations/:id/kiosk-tokens', () => {
  it('records the revocation of the location tokens', async () => {
    const url = `/api/v1/locations/${f.locationId}/kiosk-tokens`;
    expect((await apiRequest(ctx.app, 'DELETE', url, other.owner)).statusCode).toBe(404);
    expect((await apiRequest(ctx.app, 'DELETE', url, f.caller)).statusCode).toBe(403);

    const response = await apiRequest(ctx.app, 'DELETE', url, f.owner);

    expect(response.statusCode).toBe(204);
    expect(ctx.kioskRevocations.revocations).toEqual([
      { tenantId: f.tenant.tenantId, locationId: f.locationId, at: expect.any(Date) },
    ]);
  });
});
