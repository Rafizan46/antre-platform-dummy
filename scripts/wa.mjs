// Simulasi pelanggan WhatsApp (dev): kirim webhook ber-signature ke WA Channel,
// lalu tampilkan balasan sandbox yang muncul di log notification-worker.
//
// Pakai:  node scripts/wa.mjs <nomor> "<teks>"
//         node scripts/wa.mjs <nomor>            (tanpa teks: hanya tampilkan 3 balasan terakhir)
// Contoh: node scripts/wa.mjs 6281234567890 "ANTRE klinik-uji pusat"
//
// Env opsional: WA_CHANNEL_URL (default http://127.0.0.1:3200), WA_APP_SECRET,
//               WORKER_LOG (default .run/logs/worker.log, ditulis oleh pnpm dev:all), WAIT_MS (default 8000)
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { loadEnv } from './lib/env.mjs';
import { logPath, readState } from './lib/state.mjs';

const [from, text] = process.argv.slice(2);
if (!from) {
  console.error('Pakai: node scripts/wa.mjs <nomor> "<teks>"');
  process.exit(1);
}

const env = loadEnv();
const state = readState();
const secret = process.env.WA_APP_SECRET ?? env.WA_APP_SECRET;
const base =
  process.env.WA_CHANNEL_URL ?? state?.urls?.waChannel ?? `http://127.0.0.1:${env.WA_CHANNEL_PORT}`;
const logFile = process.env.WORKER_LOG ?? state?.logs?.worker ?? logPath('worker');
const waitMs = Number(process.env.WAIT_MS ?? 8000);

function readReplies() {
  if (!existsSync(logFile)) return [];
  const out = [];
  for (const line of readFileSync(logFile, 'utf8').split(/\r?\n/)) {
    if (!line.includes('sandbox whatsapp message')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // baris log lain
    }
  }
  return out;
}

function show(replies) {
  if (replies.length === 0) console.log('(belum ada balasan)');
  for (const m of replies) {
    const when = new Date(m.time).toLocaleTimeString('id-ID');
    console.log(`\n--- balasan ${when} -> ${m.to} (${m.template ?? m.kind}) ---`);
    console.log(m.text);
  }
}

if (!text) {
  show(readReplies().slice(-3));
  process.exit(0);
}

const before = readReplies().length;

const body = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550000000', phone_number_id: '1' },
            contacts: [{ wa_id: from, profile: { name: 'Pelanggan Uji' } }],
            messages: [
              {
                from,
                id: `wamid.MANUAL${randomUUID().replace(/-/g, '')}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
};

const raw = JSON.stringify(body);
const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
const res = await fetch(`${base}/api/v1/channels/wa/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  body: raw,
});
console.log(`webhook: HTTP ${res.status}`);
if (res.status !== 200) {
  console.log(await res.text());
  process.exit(1);
}

// Tunggu balasan baru muncul di log worker, lalu beri jeda kecil untuk balasan susulan.
const deadline = Date.now() + waitMs;
while (Date.now() < deadline && readReplies().length === before) {
  await new Promise((r) => setTimeout(r, 400));
}
await new Promise((r) => setTimeout(r, 800));
show(readReplies().slice(before));
