import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEMO, seedDemo } from './demo-seed.mjs';

/** API palsu dalam memori: cukup untuk memeriksa idempotensi seed. */
function fakeApi() {
  const db = { registered: false, services: [], resources: [], users: new Set(), calls: [] };
  const request = async (method, path, { body } = {}) => {
    db.calls.push(`${method} ${path}`);
    const reply = (status, payload) => ({ status, body: payload });
    if (path === '/api/v1/auth/register') {
      if (db.registered) return reply(409, { error: { code: 'ALREADY_EXISTS' } });
      db.registered = true;
      return reply(201, {});
    }
    if (path === '/api/v1/auth/login') return reply(200, { access_token: 'tok' });
    if (path === '/api/v1/locations') {
      return reply(200, { locations: [{ id: 'loc1', code: DEMO.location.code }] });
    }
    if (path === '/api/v1/catalog/services') {
      if (method === 'GET') return reply(200, { services: db.services });
      const service = { id: `svc${db.services.length}`, ...body };
      db.services.push(service);
      return reply(201, service);
    }
    if (path.startsWith('/api/v1/catalog/resources') && method === 'GET') {
      return reply(200, { resources: db.resources });
    }
    if (path === '/api/v1/catalog/resources') {
      const resource = { id: `res${db.resources.length}`, is_active: true, ...body };
      db.resources.push(resource);
      return reply(201, resource);
    }
    if (path.startsWith('/api/v1/catalog/resources/')) return reply(200, {});
    if (path.includes('/operating-hours') || path === '/api/v1/tenants/me/settings') {
      return reply(200, {});
    }
    if (path === '/api/v1/users') {
      if (db.users.has(body.email)) return reply(409, {});
      db.users.add(body.email);
      return reply(201, {});
    }
    if (path.endsWith('/kiosk-tokens')) {
      return reply(201, { token: `kiosk${db.calls.length}`, expires_at: '2030-01-01T00:00:00Z' });
    }
    return reply(404, { path });
  };
  return { db, request };
}

test('seed pertama membuat tenant, 2 layanan, 2 resource, 2 staf, dan token kiosk', async () => {
  const { db, request } = fakeApi();
  const result = await seedDemo(request);
  assert.equal(db.services.length, 2);
  assert.equal(db.services.filter((s) => s.requires_dp).length, 1);
  assert.equal(db.resources.length, 2);
  assert.equal(db.resources[0].service_ids.length, 2);
  assert.equal(db.users.size, 2);
  assert.ok(result.kioskToken.startsWith('kiosk'));
  assert.ok(result.created.length >= 7);
});

function kioskFrom(result, isValid) {
  return {
    token: result.kioskToken,
    locationId: result.locationId,
    expiresAt: '2099-01-01T00:00:00Z',
    isValid: async () => isValid,
  };
}

test('seed kedua idempoten: data tidak ganda, token kiosk lama dipakai ulang, tidak ada perubahan', async () => {
  const { db, request } = fakeApi();
  const first = await seedDemo(request);
  const second = await seedDemo(request, DEMO, kioskFrom(first, true));
  assert.equal(db.services.length, 2);
  assert.equal(db.resources.length, 2);
  assert.equal(db.users.size, 2);
  assert.equal(second.kioskToken, first.kioskToken);
  assert.equal(db.calls.filter((call) => call.endsWith('/kiosk-tokens')).length, 1);
  assert.deepEqual(second.created, []);
});

test('token kiosk lama yang tidak valid diganti dan dilaporkan jujur', async () => {
  const { request } = fakeApi();
  const first = await seedDemo(request);
  const second = await seedDemo(request, DEMO, kioskFrom(first, false));
  assert.notEqual(second.kioskToken, first.kioskToken);
  assert.equal(second.created.length, 1);
  assert.match(second.created[0], /token kiosk baru/);
});

test('seed gagal dengan pesan jelas bila API menolak', async () => {
  const request = async () => ({ status: 500, body: { error: 'x' } });
  await assert.rejects(seedDemo(request), /HTTP 500/);
});
