// pnpm demo:seed: mengisi tenant demo "Klinik Demo" lewat API core-services (idempoten).
// Env opsional: CORE_SERVICES_URL (default dari .run/state.json atau .env.example), WEB_URL.
// pnpm demo:seed --superadmin  juga membuat akun SUPER_ADMIN demo (lihat demo-superadmin.mjs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadEnv } from './lib/env.mjs';
import { DEMO, seedDemo } from './lib/demo-seed.mjs';
import { readState, RUN_DIR } from './lib/state.mjs';

const env = loadEnv();
const state = readState();
const coreUrl = process.env.CORE_SERVICES_URL || state?.urls?.core || env.CORE_SERVICES_URL;
const webUrl = process.env.WEB_URL || state?.urls?.web || 'http://127.0.0.1:5173';
const waUrl = state?.urls?.waChannel || `http://127.0.0.1:${env.WA_CHANNEL_PORT}`;

const kioskFile = path.join(RUN_DIR, 'demo-kiosk.json');
const realtimeUrl = state?.urls?.realtime || `http://127.0.0.1:${env.REALTIME_PORT}`;

function loadKiosk() {
  try {
    const saved = existsSync(kioskFile) ? JSON.parse(readFileSync(kioskFile, 'utf8')) : null;
    if (!saved?.token) return null;
    return {
      ...saved,
      // Valid = gateway realtime menerima token (belum dicabut, belum kedaluwarsa).
      async isValid(token, locationId) {
        const controller = new AbortController();
        try {
          const response = await fetch(
            `${realtimeUrl}/api/v1/realtime/locations/${locationId}/stream`,
            {
              headers: { authorization: `Bearer ${token}` },
              signal: controller.signal,
            },
          );
          return response.status === 200;
        } catch {
          return false;
        } finally {
          controller.abort();
        }
      },
    };
  } catch {
    return null;
  }
}

async function request(method, path, { token, body } = {}) {
  const response = await fetch(`${coreUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

try {
  const health = await fetch(`${coreUrl}/readyz`, { signal: AbortSignal.timeout(3000) }).catch(
    () => null,
  );
  if (health?.status !== 200) {
    throw new Error(`core-services tidak menjawab di ${coreUrl}. Jalankan dulu: pnpm dev:all`);
  }
  const result = await seedDemo(request, DEMO, loadKiosk());
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(
    kioskFile,
    JSON.stringify({
      token: result.kioskToken,
      locationId: result.locationId,
      expiresAt: result.kioskExpiresAt,
    }),
  );
  console.log(
    result.created.length > 0
      ? `Dibuat/diperbarui:\n  - ${result.created.join('\n  - ')}`
      : 'Data demo sudah lengkap (tidak ada yang berubah).',
  );
  console.log(`
==================== Tenant demo siap ====================
 Slug tenant   : ${DEMO.slug}      Kode lokasi: ${DEMO.location.code}
 Web staf      : ${webUrl}
 Login owner   : ${DEMO.owner.email} / ${DEMO.owner.password}
 Login caller  : ${DEMO.caller.email} / ${DEMO.caller.password}
 Login kasir   : ${DEMO.cashier.email} / ${DEMO.cashier.password}
 Kiosk TV      : ${webUrl}/kiosk.html?token=${result.kioskToken}
 Webhook WA    : ${waUrl}/api/v1/channels/wa/webhook

 Simulasi pelanggan WhatsApp:
   pnpm wa 6281234567890 "ANTRE ${DEMO.slug} ${DEMO.location.code}"
   pnpm wa 6281234567890 "STATUS"
   pnpm wa 6281234567890 "BATAL"
 (Kredensial di atas hanya untuk demo lokal.)
==========================================================`);
} catch (error) {
  console.error(`[demo:seed] GAGAL: ${error.message}`);
  process.exit(1);
}

if (process.argv.includes('--superadmin')) {
  await import('./demo-superadmin.mjs');
}
