// pnpm admin:tenants: login sebagai SUPER_ADMIN demo lalu tampilkan GET /api/v1/admin/tenants
// (tanpa curl). Env opsional: SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD, CORE_SERVICES_URL.
import { loadEnv } from './lib/env.mjs';
import { readState } from './lib/state.mjs';
import { SUPERADMIN } from './lib/superadmin.mjs';

const env = loadEnv();
const coreUrl = process.env.CORE_SERVICES_URL || readState()?.urls?.core || env.CORE_SERVICES_URL;
const email = process.env.SUPERADMIN_EMAIL || SUPERADMIN.email;
const password = process.env.SUPERADMIN_PASSWORD || SUPERADMIN.password;

const login = await fetch(`${coreUrl}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (login.status !== 200) {
  console.error(
    `Login SUPER_ADMIN gagal (HTTP ${login.status}). Sudah menjalankan pnpm demo:superadmin?`,
  );
  process.exit(1);
}
const { access_token: token } = await login.json();
const response = await fetch(`${coreUrl}/api/v1/admin/tenants`, {
  headers: { authorization: `Bearer ${token}` },
});
const body = await response.json();
if (response.status !== 200) {
  console.error(`GET /admin/tenants: HTTP ${response.status}`, JSON.stringify(body));
  process.exit(1);
}
console.log(`Total tenant: ${body.total}`);
for (const tenant of body.tenants) {
  const state = tenant.suspended ? 'TERSUSPEND' : 'aktif';
  console.log(`- ${tenant.slug} (${tenant.name}) [${state}] id=${tenant.id}`);
}
