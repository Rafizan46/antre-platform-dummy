// Data demo untuk screenshot: seed tenant (idempoten), tiket lewat webhook WA bertanda tangan
// (cadangan: API staf), dan transisi status tiket. Hanya membaca/mengisi data demo.
import { createHmac, randomUUID } from 'node:crypto';

import { DEMO, seedDemo } from './demo-seed.mjs';

/** Tenant kedua yang tidak pernah diberi tiket: untuk layar "dashboard kosong". */
export const DEMO_EMPTY = {
  ...DEMO,
  slug: 'klinik-kosong',
  tenantName: 'Klinik Kosong',
  adminPhone: '6281200000002',
  owner: { email: 'owner@klinik-kosong.test', password: 'Demo-Owner-123' },
  caller: { email: 'caller@klinik-kosong.test', password: 'Demo-Caller-123', role: 'STAFF_CALLER' },
  cashier: {
    email: 'cashier@klinik-kosong.test',
    password: 'Demo-Cashier-123',
    role: 'STAFF_CASHIER',
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeRequest(base) {
  return async function request(method, path, { token, body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
}

export function waBody(from, text) {
  return {
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
              contacts: [{ wa_id: from, profile: { name: 'Pelanggan Demo' } }],
              messages: [
                {
                  from,
                  id: `wamid.SHOT${randomUUID().replace(/-/g, '')}`,
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
}

export function signBody(raw, secret) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

/**
 * Menyiapkan dunia demo. Mengembalikan objek dengan kiosk token, id lokasi, dan fungsi `ensure`
 * (level 'waiting' | 'called' | 'serving') yang menaikkan status antrean secara idempoten.
 */
export async function prepareWorld({ apiBase, waBase, waSecret, log }) {
  const request = makeRequest(apiBase);
  const health = await fetch(`${apiBase}/readyz`, { signal: AbortSignal.timeout(5_000) }).catch(
    () => null,
  );
  if (health?.status !== 200) {
    throw new Error(
      `core-services tidak menjawab di ${apiBase}. Jalankan pnpm dev:all atau pakai --start.`,
    );
  }
  const seeded = await seedDemo(request, DEMO, null);
  await seedDemo(request, DEMO_EMPTY, null);
  log(`seed: ${seeded.created.length > 0 ? seeded.created.join('; ') : 'data demo sudah lengkap'}`);

  const login = await request('POST', '/api/v1/auth/login', {
    body: { email: DEMO.owner.email, password: DEMO.owner.password },
  });
  if (login.status !== 200) throw new Error(`login owner demo gagal: HTTP ${login.status}`);
  const token = login.body.access_token;
  const locationId = seeded.locationId;
  const warnings = [];

  const listTickets = async () =>
    (await request('GET', `/api/v1/queues/tickets?location_id=${locationId}`, { token })).body
      ?.tickets ?? [];

  async function viaWebhook(phone, text) {
    const raw = JSON.stringify(waBody(phone, text));
    const response = await fetch(`${waBase}/api/v1/channels/wa/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signBody(raw, waSecret),
      },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) throw new Error(`webhook HTTP ${response.status}`);
  }

  /** Satu pelanggan WA: ANTRE -> 1 (ambil antrean) -> 1 (layanan pertama). */
  async function createViaWa(index) {
    const before = (await listTickets()).length;
    const phone = `62813${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    try {
      // Tidak ada sinyal yang dapat diamati antar-pesan percakapan selain hasil akhir; jeda singkat
      // menjaga urutan pemrosesan sesi pelanggan yang sama.
      for (const text of [`ANTRE ${DEMO.slug} ${DEMO.location.code}`, '1', '1']) {
        await viaWebhook(phone, text);
        await sleep(1_200);
      }
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if ((await listTickets()).length > before) return 'wa';
        await sleep(400);
      }
      throw new Error('tiket tidak muncul setelah percakapan WA');
    } catch (error) {
      warnings.push(`tiket ${index}: WA gagal (${error.message}); memakai API staf`);
      const created = await request('POST', '/api/v1/queues/tickets', {
        token,
        body: {
          location_id: locationId,
          service_id: seeded.serviceIds[0],
          customer_name: `Pelanggan ${index}`,
        },
      });
      if (created.status !== 201)
        throw new Error(`buat tiket gagal: HTTP ${created.status}`, { cause: error });
      return 'api';
    }
  }

  async function callOne() {
    const tickets = await listTickets();
    if (!tickets.some((t) => t.status === 'WAITING')) return null;
    const busy = new Set(
      tickets
        .filter((t) => t.status === 'CALLED' || t.status === 'SERVING')
        .map((t) => t.resource_id),
    );
    const resourceId = seeded.resourceIds.find((id) => !busy.has(id));
    if (!resourceId) return null;
    const waiting = tickets.find((t) => t.status === 'WAITING');
    const serviceId = waiting.service_id;
    const called = await request('POST', '/api/v1/queues/tickets/call-next', {
      token,
      body: { location_id: locationId, service_id: serviceId, resource_id: resourceId },
    });
    return called.body?.ticket ?? null;
  }

  async function ensureWaiting(count) {
    let tickets = await listTickets();
    let made = 0;
    while (tickets.filter((t) => t.status === 'WAITING').length < count && made < 8) {
      made += 1;
      await createViaWa(made);
      tickets = await listTickets();
    }
  }

  const rank = { waiting: 0, called: 1, serving: 2 };
  async function ensure(level) {
    await ensureWaiting(level === 'waiting' ? 3 : 4);
    if (rank[level] >= 1) {
      let tickets = await listTickets();
      if (!tickets.some((t) => t.status === 'CALLED' || t.status === 'SERVING')) await callOne();
      tickets = await listTickets();
      if (rank[level] >= 2 && !tickets.some((t) => t.status === 'SERVING')) {
        const called = tickets.find((t) => t.status === 'CALLED');
        if (called) {
          await request('POST', `/api/v1/queues/tickets/${called.id}/actions`, {
            token,
            body: { action: 'SERVE' },
          });
        }
        // Panggilan kedua agar layar menampilkan Dipanggil dan Dilayani sekaligus.
        await callOne();
      }
    }
    // Pastikan masih ada yang menunggu setelah pemanggilan.
    await ensureWaiting(2);
  }

  return {
    kioskToken: seeded.kioskToken,
    locationId,
    warnings,
    ensure,
    demo: DEMO,
    empty: DEMO_EMPTY,
    ticketCount: async () => (await listTickets()).length,
  };
}
