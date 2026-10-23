import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashPassword } from './hash.mjs';
import { upsertSuperAdmin } from './superadmin.mjs';

function fakeClient(existing) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: sql.trimStart().startsWith('SELECT') && existing ? [{ id: 'u1' }] : [] };
    },
  };
}

test('membuat SUPER_ADMIN tanpa tenant bila belum ada', async () => {
  const client = fakeClient(false);
  assert.equal(await upsertSuperAdmin(client, { email: 'a@b.test', passwordHash: 'h' }), 'created');
  const insert = client.queries.at(-1);
  assert.match(insert.sql, /INSERT INTO users \(tenant_id, email, password_hash, role\)/);
  assert.match(insert.sql, /NULL/);
  assert.deepEqual(insert.params, ['a@b.test', 'h']);
});

test('menyetel ulang password bila sudah ada', async () => {
  const client = fakeClient(true);
  assert.equal(
    await upsertSuperAdmin(client, { email: 'a@b.test', passwordHash: 'h2' }),
    'updated',
  );
  assert.match(client.queries.at(-1).sql, /UPDATE users/);
});

test('hashPassword memakai format scrypt yang didokumentasikan', async () => {
  const hash = await hashPassword('Demo-Super-123');
  assert.match(hash, /^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
});
