// pnpm demo:superadmin: membuat/menyetel ulang akun SUPER_ADMIN demo lewat DATABASE_MIGRATOR_URL
// (role antre_migrator). Env opsional: SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD.
import { createRequire } from 'node:module';
import path from 'node:path';

import { loadEnv, ROOT } from './lib/env.mjs';
import { hashPassword } from './lib/hash.mjs';
import { readState } from './lib/state.mjs';
import { SUPERADMIN, upsertSuperAdmin } from './lib/superadmin.mjs';

const env = loadEnv();
const email = (process.env.SUPERADMIN_EMAIL || SUPERADMIN.email).toLowerCase();
const password = process.env.SUPERADMIN_PASSWORD || SUPERADMIN.password;
const coreUrl = process.env.CORE_SERVICES_URL || readState()?.urls?.core || env.CORE_SERVICES_URL;

// pg adalah dependensi packages/db; dipakai dari sana tanpa menambah dependensi root.
const require = createRequire(path.join(ROOT, 'packages/db/package.json'));
const pg = require('pg');

const client = new pg.Client({ connectionString: env.DATABASE_MIGRATOR_URL });
try {
  await client.connect();
  const outcome = await upsertSuperAdmin(client, {
    email,
    passwordHash: await hashPassword(password),
  });
  console.log(`Akun SUPER_ADMIN ${outcome === 'created' ? 'dibuat' : 'disetel ulang'}.`);
  console.log(`
==================== SUPER_ADMIN demo ====================
 Login   : ${email} / ${password}
 Cara pakai (konsol admin hanya lewat API, belum ada UI):
   pnpm admin:tenants          login + daftar tenant (tanpa curl, semua shell)
 PowerShell:
   $r = Invoke-RestMethod -Method Post -Uri ${coreUrl}/api/v1/auth/login -ContentType 'application/json' -Body '{"email":"${email}","password":"${password}"}'
   Invoke-RestMethod -Uri ${coreUrl}/api/v1/admin/tenants -Headers @{ Authorization = "Bearer $($r.access_token)" }
 bash:
   TOKEN=$(curl -s -X POST ${coreUrl}/api/v1/auth/login \\
     -H 'content-type: application/json' \\
     -d '{"email":"${email}","password":"${password}"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
   curl -H "authorization: Bearer $TOKEN" ${coreUrl}/api/v1/admin/tenants
   curl -H "authorization: Bearer $TOKEN" ${coreUrl}/api/v1/admin/usage
   curl -X POST -H "authorization: Bearer $TOKEN" ${coreUrl}/api/v1/admin/tenants/<id>/suspend
 (Kredensial hanya untuk demo lokal.)
==========================================================`);
} catch (error) {
  console.error(`[demo:superadmin] GAGAL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
