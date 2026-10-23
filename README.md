# Antre Platform

Monorepo platform SaaS antrean virtual dan reservasi slot multi-tenant untuk UMKM (Tugas Besar Komputasi Layanan, Kelompok 09). Dokumen desain (`docs/`) disimpan lokal dan tidak ikut di-commit.

## Struktur

| Path                                         | Isi                                                                          | Status                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| `apps/gateway`                               | Catatan API Gateway Traefik (konfigurasi: `infra/traefik`, `infra/k8s`)      | aktif                                   |
| `apps/core-services`                         | Tenant & Auth, Catalog, Queue (Fastify)                                      | aktif                                   |
| `apps/wa-channel`                            | WA Channel Service: webhook Meta dan mesin percakapan (Fastify)              | aktif                                   |
| `apps/realtime-gateway`                      | Realtime SSE Gateway (Fastify)                                               | aktif                                   |
| `apps/notification-worker`                   | Konsumer RabbitMQ pengirim pesan WhatsApp                                    | aktif                                   |
| `apps/web-staff`                             | Web staff: Dashboard, Konsol Super Admin, Kiosk TV (React + Vite)            | Dashboard staf/owner dan Kiosk TV aktif |
| `packages/shared-types`                      | `@antre/shared-types`: enum status dan role                                  | aktif                                   |
| `packages/event-contracts`                   | `@antre/event-contracts`: envelope dan katalog event                         | aktif                                   |
| `packages/messaging`                         | `@antre/messaging`: topologi RabbitMQ, koneksi, publisher event              | aktif                                   |
| `packages/db`                                | `@antre/db`: migrasi SQL (node-pg-migrate), role dev, tes RLS                | aktif                                   |
| `infra/docker`, `infra/traefik`, `infra/k8s` | Dockerfile multi-stage, gateway Traefik, manifest k3s (kustomize)            | aktif                                   |
| `e2e`                                        | `@antre/e2e`: tes E2E customer journey (Vitest) terhadap service hasil build | aktif                                   |
| `.github/workflows`                          | CI GitHub Actions                                                            | aktif                                   |

## Prasyarat

- Node.js 22, minimal 22.13 (`.nvmrc`)
- pnpm 11.28.6 lewat Corepack (dikunci di field `packageManager` pada `package.json`)
- Docker Desktop atau Docker Engine dengan Docker Compose v2

## Memasang pnpm

Corepack ikut terpasang bersama Node.js 22. Di dalam repo, Corepack memakai versi pnpm dari field `packageManager`. Aktifkan shim pnpm, lalu tetapkan pnpm 11.28.6 sebagai versi default Corepack (dipakai saat `pnpm` dijalankan di luar repo):

```sh
corepack enable pnpm
corepack install -g pnpm@11.28.6
```

Di Windows tanpa hak administrator, folder instalasi Node.js (`C:\Program Files\nodejs`) tidak bisa ditulis. Pasang shim di folder npm global milik pengguna (sudah ada di `PATH`), lalu jalankan `corepack install -g` yang sama:

```sh
# Git Bash
corepack enable pnpm --install-directory "$APPDATA/npm"
# PowerShell
corepack enable pnpm --install-directory "$env:APPDATA\npm"
# Git Bash dan PowerShell
corepack install -g pnpm@11.28.6
```

`corepack install -g` diperlukan karena saat shim pnpm pertama kali dipakai tanpa versi default, Corepack mengambil pnpm `latest` dari registry dan mencatatnya sebagai default (`lastKnownGood.json`, di Windows pada `%LOCALAPPDATA%\node\corepack`). Corepack 0.31 (bawaan Node.js 22.14) tidak bisa menjalankan default itu (pnpm 12), sehingga `pnpm` di luar repo gagal dengan `MODULE_NOT_FOUND`. `corepack install -g pnpm@11.28.6` mencatat 11.28.6 sebagai default.

Bila Corepack gagal, pasang versi yang sama lewat npm:

```sh
npm install -g pnpm@11.28.6
```

Di root repo maupun di luar repo (mis. `cd ~`), `pnpm --version` harus mencetak `11.28.6`.

pnpm 12 belum dipakai karena Corepack 0.31 (bawaan Node.js 22.14) menjalankan pnpm lewat `bin/pnpm.cjs`, sedangkan paket pnpm 12 tidak lagi menyertakan file itu. Corepack yang lebih baru (0.36) menjalankan `bin/pnpm.mjs`; naik ke pnpm 12 diputuskan terpisah.

pnpm bisa mencetak pesan `Update available!` (mis. `11.28.6 → 12.14.0`) beserta perintah `Invoke-WebRequest ...` untuk memasang versi baru. Abaikan pesan itu dan jangan memasang pnpm standalone: versi pnpm repo ini dikunci di `packageManager` dan dijalankan lewat Corepack.

## Perintah

```sh
pnpm install                          # instal dependensi semua paket
pnpm -r typecheck                     # TypeScript strict (tsc --noEmit)
pnpm -r lint                          # ESLint
pnpm -r test                          # Vitest
pnpm format                           # Prettier, menulis perubahan
pnpm format:check                     # Prettier, cek saja (dipakai CI)
pnpm e2e                              # build 4 service lalu jalankan tes E2E (butuh PostgreSQL, Redis, RabbitMQ)
pnpm --filter @antre/web-staff dev    # dev server web staff di http://localhost:5173
pnpm --filter @antre/web-staff build  # build produksi web staff
```

Versi dependensi dikunci di `catalog` pada `pnpm-workspace.yaml`; `package.json` tiap paket memakai `"catalog:"`. pnpm 11 hanya me-resolve versi yang sudah terbit minimal 24 jam (`minimumReleaseAge`) dan menolak build script dependensi yang belum disetujui di `allowBuilds`.

## Lingkungan dev (Docker)

```sh
docker compose -f docker-compose.dev.yml up -d --wait   # jalankan dan tunggu sampai healthy
docker compose -f docker-compose.dev.yml ps             # status
docker compose -f docker-compose.dev.yml down           # hentikan, data tetap di volume
docker compose -f docker-compose.dev.yml down -v        # hentikan dan hapus data
```

Nilai default (user, password, port) ada di `docker-compose.dev.yml` dan hanya untuk pengembangan lokal. Untuk mengubahnya, salin `.env.example` menjadi `.env` lalu ubah nilainya; `.env` tidak di-commit.

Port host memakai pola port default + 30000 dan hanya terikat ke `127.0.0.1`, sehingga tidak bentrok dengan PostgreSQL, Redis, atau RabbitMQ yang terpasang lokal (mis. PostgreSQL lokal di 5432):

| Layanan             | Image                              | Host → container | Koneksi dari host                                        |
| ------------------- | ---------------------------------- | ---------------- | -------------------------------------------------------- |
| PostgreSQL 16       | `postgres:16.15-alpine`            | 35432 → 5432     | `postgres://postgres:postgres_dev@127.0.0.1:35432/antre` |
| Redis               | `redis:8.10.2-alpine`              | 36379 → 6379     | `redis://127.0.0.1:36379`                                |
| RabbitMQ (AMQP)     | `rabbitmq:4.3.6-management-alpine` | 35672 → 5672     | `amqp://antre:rabbitmq_dev@127.0.0.1:35672`              |
| RabbitMQ Management | (sama)                             | 45672 → 15672    | http://127.0.0.1:45672 (`antre` / `rabbitmq_dev`)        |

Bila port host sudah terpakai, ubah variabel `*_HOST_PORT` di `.env`. Di Windows, hindari port 49152 sampai 65535 (rentang port dinamis yang bisa direservasi Hyper-V/WSL; cek dengan `netsh interface ipv4 show excludedportrange protocol=tcp`).

Topologi RabbitMQ (`antre.events`, queue `notifications.*`, dan `wa.inbound*`) dideklarasikan otomatis oleh setiap service saat terhubung (bagian Notification Worker). Mock WhatsApp Cloud API berupa adapter sandbox di dalam worker; webhook masuk disimulasikan dengan POST bertanda tangan ke WA Channel Service (bagian WA Channel Service). Simulator pembayaran QRIS belum ada dan ditambahkan di workstream terkait. Role dan skema database ada di `packages/db` (bagian berikut).

## Database (`packages/db`)

Skema PostgreSQL (spesifikasi §6) dikelola dengan migrasi SQL murni node-pg-migrate di `packages/db/migrations`. Paket ini tidak berisi kode runtime; service nanti terhubung sendiri sebagai `antre_app`.

Dari nol, setelah lingkungan Docker `up`:

```sh
pnpm db:setup              # = pnpm db:bootstrap && pnpm db:migrate
pnpm db:test:integration   # tes integrasi di database sementara antre_it
```

- `pnpm db:bootstrap` (koneksi `DATABASE_ADMIN_URL`, superuser `postgres`): khusus dev dan CI. Menjalankan `packages/db/bootstrap`: role `antre_migrator`, `antre_app`, `antre_platform_admin`, `antre_definer` dengan password placeholder dev, plus hak `CREATE` di schema `public`. Di produksi langkah ini dikerjakan admin database (§6.1).
- `pnpm db:migrate` (koneksi `DATABASE_MIGRATOR_URL`): menerapkan migrasi yang belum jalan, yaitu tabel, RLS, policy, GRANT, 7 fungsi `SECURITY DEFINER`, seed paket `FREE` dan `PAID_LOCATION`, dan (S11) kolom `suspended_at` pada `tenants`/`locations` dengan `UPDATE (suspended_at)` + policy `platform_admin_suspend` untuk `antre_platform_admin`.
- `pnpm db:migrate:down` (koneksi `DATABASE_MIGRATOR_URL`): membatalkan satu migrasi terakhir. Dua kali berturut-turut = skema kosong (data dev hilang).
- `pnpm db:test:integration` (semua `DATABASE_*_URL`): membuat database `antre_it` dan `antre_it_roundtrip`, menjalankan bootstrap dan migrasi, menguji isolasi tenant, lalu menghapus keduanya. Database `antre` tidak disentuh.

URL koneksi dibaca lewat `node --env-file` dari `.env.example`, lalu `.env` bila ada; variabel lingkungan shell selalu menang. Tidak perlu membuat `.env`, dan pesan `../../.env not found. Continuing without it.` itu normal. Bila port atau password PostgreSQL diubah di `.env`, ubah juga keempat `DATABASE_*_URL` di `.env` yang sama.

`pnpm -r test` hanya menjalankan tes statis `packages/db` (tanpa database), jadi tetap hijau tanpa Docker. Tes integrasi butuh PostgreSQL di `127.0.0.1` atau `localhost` (helper tes menolak host lain karena membuat dan menghapus database) dan tidak boleh dijalankan bersamaan pada server yang sama.

Aturan saat menambah migrasi:

- File baru `packages/db/migrations/<timestamp milidetik>_<nama>.sql` berisi `-- Up Migration` lalu `-- Down Migration`. Migrasi yang sudah di-commit tidak diubah.
- Tabel yang bergantung tenant: kolom `tenant_id`, `ENABLE` dan `FORCE ROW LEVEL SECURITY`, policy `tenant_isolation` untuk `antre_app`, GRANT ke `antre_app`, dan masuk daftar tabel di tes `packages/db/test`.
- Fungsi `SECURITY DEFINER` hanya dari daftar tertutup §6.1, dengan urutan: `CREATE FUNCTION ... SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO antre_app`, lalu terakhir `ALTER FUNCTION ... OWNER TO antre_definer`. `antre_migrator` adalah anggota `antre_definer` dengan `INHERIT FALSE`, jadi setelah kepemilikan pindah ia tidak bisa lagi mengubah ACL; untuk mengganti atau menghapus fungsi pakai `SET LOCAL ROLE antre_definer` (contoh di down migration fungsi).
- DML di migrasi berjalan sebagai `antre_migrator` dan tunduk RLS (`FORCE`): baris tenant tidak terlihat.

Akun `SUPER_ADMIN` (tanpa tenant) dibuat operator platform lewat koneksi `antre_migrator`; policy `super_admin_provisioning` hanya mengizinkan baris dengan `tenant_id` NULL dan role `SUPER_ADMIN`. Hash password berformat `scrypt$32768$8$3$<salt>$<hash>` dari `hashPassword` (`apps/core-services/src/auth/password.ts`); alat CLI menyusul:

```sql
INSERT INTO users (tenant_id, email, password_hash, role)
VALUES (NULL, 'admin@contoh.id', '<hash password>', 'SUPER_ADMIN');
```

Reset database dev: `docker compose -f docker-compose.dev.yml down -v`, lalu `up -d --wait` dan `pnpm db:setup`.

## Core services (`apps/core-services`)

Endpoint `/api/v1` (daftar lengkap di `docs/spesifikasi-sistem-antre.md` §8; respons daftar berbentuk objek, mis. `{ "locations": [...] }`):

- Tenant & Auth: `POST /auth/register`, `POST /auth/login`, `GET|POST /users`, `PATCH /users/:id` (OWNER), `GET|PATCH /tenants/me/settings`.
- Lokasi: `GET|POST /locations`, `PATCH /locations/:id` (tulis: OWNER); token Kiosk TV: `POST /locations/:id/kiosk-tokens` (OWNER, token `KIOSK_DISPLAY` 30 hari) dan `DELETE /locations/:id/kiosk-tokens` (OWNER, mencabut semua token kiosk lokasi yang sudah terbit).
- Katalog: `GET|POST /catalog/services`, `PATCH /catalog/services/:id`, `GET|POST /catalog/resources`, `PATCH /catalog/resources/:id`, `GET|PUT /catalog/locations/:location_id/operating-hours`.
- Antrean: `POST|GET /queues/tickets`, `POST /queues/tickets/call-next`, `POST /queues/tickets/:id/actions` (RECALL, SERVE, COMPLETE, NO_SHOW).
- Reservasi: `GET /bookings?location_id&date` (kalender slot; OWNER, STAFF_CALLER, STAFF_CASHIER), `POST /bookings/:id/actions` (COMPLETE, NO_SHOW, CANCEL; OWNER, STAFF_CASHIER).
- Pembayaran (tanpa JWT, dipanggil penyedia QRIS): `POST /payments/qris/callback`. Body JSON mentah ditandatangani HMAC-SHA256 dengan `PAYMENT_CALLBACK_SECRET`, dikirim di header `X-Antre-Signature: sha256=<hex>`; callback diproses idempoten per `payment_ref`.
- Langganan (S11, OWNER): `GET /billing/plans`, `GET /billing/locations/:id/subscription` (paket, status, periode, `next_billing_at`, pemakaian bulan berjalan menurut zona waktu lokasi, riwayat 6 bulan), `GET /billing/locations/:id/usage`, `POST /billing/locations/:id/subscription/checkout` (201: `payment_ref` baru, Rp150.000, QRIS simulasi berlaku 15 menit; checkout terbuka sebelumnya digantikan). Konfirmasi lewat `POST /billing/payments/callback` (tanpa JWT, HMAC dan parser body mentah yang sama dengan callback booking; payload `payment_ref`, `tenant_id`, `target_id` = id langganan, `amount`, `status`): tepat waktu dan nominal cocok -> `ACTIVE` `PAID_LOCATION` 1 bulan (perpanjangan: +1 bulan dari akhir periode) dan event `billing.subscription.activated`; terlambat, nominal salah, atau `payment_ref` lama -> 409 `PAYMENT_NOT_APPLICABLE` dan log audit `payment_not_applicable` (refund manual oleh Super Admin); ulang -> kode yang sama. Job langganan (tiap 5 menit, advisory lock, aman multi-replika) menutup checkout kedaluwarsa dan menurunkan `PAID_LOCATION` yang periodenya habis ke `FREE` (tanpa masa tenggang, spesifikasi §6.3); kuota bulan berjalan langsung berlaku (402 `QUOTA_EXCEEDED`).
- Konsol Super Admin (S11, hanya `SUPER_ADMIN`, koneksi `antre_platform_admin` dari `DATABASE_PLATFORM_ADMIN_URL`): `GET /admin/tenants?status=active|suspended&limit&offset` (tenant, lokasi, paket, status langganan, pemakaian bulan berjalan; tanpa nomor WA), `GET /admin/tenants/:id` (+ riwayat 6 bulan per lokasi), `GET /admin/usage?period_month=YYYY-MM-01`, `POST /admin/tenants/:id/suspend|activate`, `POST /admin/locations/:id/suspend|activate`. Tenant tersuspend: semua route owner/staf 403 `FORBIDDEN` dengan `details.reason = TENANT_SUSPENDED`; tenant atau lokasi tersuspend tidak menerima tiket/hold baru (409 `LOCATION_CLOSED`, `details.reason = SUSPENDED`) dan `wa-context` melaporkan `is_active = false` sehingga WhatsApp membalas dengan pesan lokasi tidak aktif. Tanpa `DATABASE_PLATFORM_ADMIN_URL` route admin menjawab 500.
- Internal untuk WhatsApp Channel Service (`/internal/v1`, jangan dirutekan lewat gateway publik): `GET /locations/resolve?slug=&code=`, `GET /locations/:id/wa-context`, `GET /customers/active-items?customer_phone=`, `POST /queues/tickets`, `GET /queues/tickets/active`, `POST /queues/tickets/:id/cancel`, `GET /catalog/services`, `GET /bookings/available-slots`, `POST /bookings/holds`, `GET /bookings/active`, `POST /bookings/:id/cancel`. Header `Authorization: Bearer <WA_CHANNEL_SERVICE_TOKEN>` dan `X-Antre-Tenant-Id`, kecuali `locations/resolve` dan `customers/active-items` yang berjalan tanpa tenant (fungsi `app_resolve_location` dan `app_find_active_by_phone`; header tenant diabaikan).

Service terhubung ke PostgreSQL sebagai `antre_app` (`DATABASE_APP_URL`) dan membaca `JWT_SECRET`, `WA_CHANNEL_SERVICE_TOKEN`, dan `PAYMENT_CALLBACK_SECRET` dari lingkungan (masing-masing minimal 32 karakter; nilai `dev-only...` di `.env.example` hanya untuk dev dan ditolak saat `NODE_ENV=production`). Host dan port listen dari `CORE_SERVICES_HOST` (default `127.0.0.1`) dan `CORE_SERVICES_PORT` (default `3000`). Hold slot reservasi memakai lock Redis (`REDIS_URL`, mis. `redis://127.0.0.1:36379`; key `lock:slot:<resource_id>:<slot_start>` selama 5 menit, dilepas dengan skrip Lua compare-and-delete). Jika Redis mati, hold tetap berjalan dan dijaga unique index `bookings_active_slot_key` (bentrok menjadi 409 `SLOT_TAKEN`); server tidak berhenti. Dua job berjalan tiap menit di server: kedaluwarsa hold (EXPIRED dan lepas lock) dan pengingat 30 menit sebelum jadwal (`booking.reservation.reminder_due`); aman untuk beberapa replika. Event `queue.*`, `booking.*`, dan `billing.quota.*` dipublikasikan ke exchange `antre.events` (RabbitMQ, `RABBITMQ_URL`) setelah commit, dengan publisher confirms dan pesan persistent. Jika RabbitMQ mati, request tetap berhasil: event disimpan di buffer memori (maks. 1000, terlama dibuang bila penuh) dan dikirim berurutan setelah koneksi pulih; buffer hilang bila proses berhenti saat broker mati (tanpa outbox, lihat spesifikasi §9.5). Sejak S10 setiap event `queue.*` dan `booking.reservation.*` (kecuali `reminder_due`) juga ditulis ke Redis setelah commit untuk Realtime SSE Gateway: satu skrip Lua menambah update ringkas tanpa PII ke stream `rt:log:{tenant_id}:{location_id}` (MAXLEN ~500, kedaluwarsa 24 jam) dan mem-PUBLISH-nya ke channel `rt:{tenant_id}:{location_id}`; Redis mati tidak menggagalkan request (dicatat di log).

```sh
pnpm --filter @antre/core-services build   # bundel Vite SSR ke apps/core-services/dist/server.js
pnpm --filter @antre/core-services start   # jalankan hasil build (butuh DATABASE_APP_URL, REDIS_URL, RABBITMQ_URL, JWT_SECRET, WA_CHANNEL_SERVICE_TOKEN, PAYMENT_CALLBACK_SECRET; opsional DATABASE_PLATFORM_ADMIN_URL)
pnpm --filter @antre/core-services dev     # build lalu jalankan dengan nilai dev dari .env.example
```

```sh
pnpm core:test:integration   # tes API + DB di database sementara antre_it_core (butuh Docker: PostgreSQL dan Redis dari docker-compose.dev.yml)
```

`pnpm -r test` hanya menjalankan tes unit, jadi tetap hijau tanpa Docker.

## Notification Worker (`apps/notification-worker`)

Konsumer queue `notifications.wa` (spesifikasi §3.5, §7.1): memetakan event ke template WhatsApp, mengirim lewat `WhatsAppAdapter`, dan mencatat setiap pesan ber-tenant di `notification_logs` (koneksi `antre_app`, tenant dari envelope dengan `SET LOCAL`). `wa.status.received` memperbarui `delivery_status` lewat `app_wa_update_delivery_status`.

- Topologi (dideklarasikan idempoten oleh setiap service saat terhubung, `packages/messaging/src/topology.ts`): exchange topic `antre.events`; queue `notifications.wa` terikat ke 13 routing key bertanda `notifications.wa` di katalog §7.1; queue tunda `notifications.wa.retry.1`/`.2`/`.3` (TTL per pesan 5 s, 25 s, 125 s, lalu kembali ke `notifications.wa`); `notifications.dlq` untuk audit (RabbitMQ Management).
- Kegagalan: `unavailable` (jaringan, HTTP 5xx) dan `rate_limited` (HTTP 429, kode rate limit Cloud API) di-retry 3 kali lalu masuk DLQ (`delivery_status = DLQ`); `rejected` (4xx lain, mis. template tidak ada) langsung ke DLQ; pesan yang bukan event valid ditolak broker ke DLQ. Header DLQ: `x-antre-retry`, `x-antre-error`, `x-antre-error-kind`, `x-antre-failed-at`, `x-antre-routing-key`.
- Idempoten per `event_id`: baris log diklaim dengan `INSERT ... ON CONFLICT` (unik `(tenant_id, event_id)`, migrasi `1792285200000_notification-log-event-key`) dan `SELECT ... FOR UPDATE`; event duplikat atau redelivery tidak dikirim dua kali. Balasan `wa.reply.requested` tanpa tenant tidak dicatat di tabel (hanya log aplikasi dan metrik `antre_wa_untenanted_replies_total`).
- Template (nama dan teks yang diajukan ke Meta, bahasa `id`): `apps/notification-worker/src/templates.ts`. Sapaan (`branding.wa_greeting`), label resource, nama lokasi, dan zona waktu (WIB/WITA/WIT) dibaca dari database tenant. Sejak S09 ada 11 template: `antre_booking_cancelled` (setiap pembatalan booking: `BATAL` pelanggan, `CANCEL` petugas, nominal salah) dan baris "QRIS (simulasi)" pada `antre_booking_payment` (tautan `<QRIS_SIMULATOR_URL>/<payment_ref>` bila env itu diisi, selain itu teks "pembayaran simulasi").
- Adapter: `WA_ADAPTER=sandbox` (default; tidak ada pesan keluar, setiap pesan dicatat di log dengan nomor disamarkan, wamid `wamid.SANDBOX.*` deterministik) atau `WA_ADAPTER=meta` (WhatsApp Cloud API; butuh `META_WA_ACCESS_TOKEN` dan `META_WA_PHONE_NUMBER_ID`, opsional `META_WA_API_VERSION`, `META_WA_API_BASE_URL`).
- Lingkungan: `DATABASE_APP_URL`, `RABBITMQ_URL`, `NOTIFICATION_PREFETCH` (default 10), `NOTIFICATION_RETRY_DELAYS_MS` (default `5000,25000,125000`), `WA_TEMPLATE_LANGUAGE` (default `id`), `LOG_LEVEL`, `NOTIFICATION_WORKER_HOST`/`NOTIFICATION_WORKER_PORT` (default `127.0.0.1:3100`: `GET /healthz`, `GET /readyz` 503 bila tidak terhubung ke broker, `GET /metrics` format Prometheus).
- Broker mati saat start tidak fatal: worker terus mencoba terhubung (backoff 0,5 s sampai 30 s). `SIGINT`/`SIGTERM`: berhenti mengonsumsi, menunggu pesan yang sedang diproses (maks. 30 s), lalu menutup koneksi.

```sh
pnpm --filter @antre/notification-worker build   # bundel Vite SSR ke apps/notification-worker/dist/server.js
pnpm --filter @antre/notification-worker start   # jalankan hasil build (butuh DATABASE_APP_URL dan RABBITMQ_URL)
pnpm --filter @antre/notification-worker dev     # build lalu jalankan dengan nilai dev dari .env.example
pnpm notif:test:integration                      # tes worker + publisher terhadap PostgreSQL dan RabbitMQ nyata
```

`pnpm notif:test:integration` membuat database `antre_it_notif` dan vhost RabbitMQ `antre_it_notif` (lewat management API `RABBITMQ_MANAGEMENT_URL`, kredensial dari `RABBITMQ_URL`), lalu menghapus keduanya; vhost `/` dan database `antre` tidak disentuh. Retry di tes memakai backoff pendek (100, 200, 300 ms).

## WA Channel Service (`apps/wa-channel`)

Pintu masuk pelanggan (spesifikasi §3.8, §5.2): webhook WhatsApp Cloud API dan mesin percakapan. Tanpa koneksi database; data diambil lewat `/internal/v1` core-services. Semua pesan keluar dikirim Notification Worker.

- `GET /api/v1/channels/wa/webhook`: verifikasi langganan (`hub.mode=subscribe`, `hub.verify_token` = `WA_VERIFY_TOKEN`, jawab `hub.challenge`; selain itu 403).
- `POST /api/v1/channels/wa/webhook`: `X-Hub-Signature-256` (HMAC-SHA256 raw body dengan `WA_APP_SECRET`, konstan-waktu; salah = 401), body maks. 256 KiB, parsing zod per pesan. Broker tidak terhubung = 503 tanpa menulis kunci dedup (Meta mengirim ulang). `messages[]` di-dedup `SET wa:msg:{wamid} 1 NX EX 86400` lalu diterbitkan sebagai `wa.message.received`; `statuses[]` sebagai `wa.status.received` (keduanya `tenant = null`); dijawab 200 tanpa menunggu percakapan.
- Konsumer `wa.inbound` (retry 5/25/125 s lewat `wa.inbound.retry.1-3`, lalu `wa.inbound.dlq` dan balasan permintaan maaf): idempoten per wamid (`wa:proc:{wamid}`), satu pesan per nomor sekaligus (`wa:lock:{phone}`), rate limit 20 pesan/menit/nomor (`wa:rl:{phone}`, satu peringatan lalu diam), jendela 24 jam.
- Percakapan (sesi `wa:conv:{phone}`, TTL 30 menit sejak pesan terakhir): `ANTRE <slug> <kode_lokasi>` → menu tombol sesuai `service_mode` (Ambil Antrean / Reservasi / Cek Status) → layanan → tiket; atau layanan → tanggal (hari dengan slot kosong dalam 7 hari) → slot (9 per halaman + "Slot berikutnya") → hold. Konfirmasi tiket/booking dikirim worker dari event domain (template). Perintah global `MENU`, `STATUS`, `BATAL`, `BANTUAN`, `STOP` (mengakhiri sesi); `STATUS`/`BATAL` tetap berfungsi tanpa sesi lewat nomor pengirim terverifikasi. Pilihan bernomor di setiap pesan interaktif; 3 jawaban tidak dikenali berturut-turut = kembali ke menu.
- Balasan = event `wa.reply.requested` (≤1 per pesan masuk, menjaga urutan). Log hanya memuat nomor tersamar dan tidak memuat isi pesan atau secret.
- Lingkungan: `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_CHANNEL_SERVICE_TOKEN`, `CORE_SERVICES_URL`, `REDIS_URL`, `RABBITMQ_URL`; opsional `META_WA_PHONE_NUMBER_ID` (filter nomor), `CORE_REQUEST_TIMEOUT_MS` (5000), `WA_SESSION_TTL_SECONDS` (1800), `WA_RATE_LIMIT_PER_MINUTE` (20), `WA_INBOUND_PREFETCH` (10), `WA_INBOUND_RETRY_DELAYS_MS` (`5000,25000,125000`), `WA_CHANNEL_HOST`/`WA_CHANNEL_PORT` (`127.0.0.1:3200`: webhook, `GET /healthz`, `GET /readyz` 503 bila broker/konsumer/Redis belum siap, `GET /metrics`), `LOG_LEVEL`.

```sh
pnpm --filter @antre/wa-channel build   # bundel Vite SSR ke apps/wa-channel/dist/server.js
pnpm --filter @antre/wa-channel start   # jalankan hasil build
pnpm --filter @antre/wa-channel dev     # build lalu jalankan dengan nilai dev dari .env.example
pnpm wa:test:integration                # core-services tertanam + PostgreSQL + Redis + RabbitMQ nyata
```

`pnpm wa:test:integration` membuat database `antre_it_wa` dan vhost `antre_it_wa`, memakai Redis database 13 (hanya kunci `wa:*` dan `lock:slot:*` yang dihapus), lalu membersihkan semuanya.

## Realtime SSE Gateway (`apps/realtime-gateway`)

Pembaruan live untuk Dashboard petugas dan Kiosk TV (spesifikasi §3.6, §5.1). Pelanggan tidak memakai SSE (hanya WhatsApp). Tanpa database; sumbernya Redis yang ditulis core-services setelah commit.

- `GET /api/v1/realtime/locations/:location_id/stream` (`text/event-stream`). Token lewat `?access_token=` (EventSource tidak bisa mengirim header) atau `Authorization: Bearer`; query tidak pernah dicatat di log. `OWNER`/`STAFF_*`: channel `rt:{tenant token}:{location_id}`, jadi lokasi tenant lain hanya menghasilkan stream kosong. `KIOSK_DISPLAY`: hanya lokasi di token, ditolak 401 bila diterbitkan sebelum pencabutan terakhir (`rt:kiosk-revoked:{tenant}:{location}`). `SUPER_ADMIN` dan token servis 403; token salah/kedaluwarsa 401; Redis mati 503; batas koneksi 429.
- Format: `retry:` lalu `event: snapshot` (`{"updates":[...]}`, 50 update terakhir) atau, dengan `Last-Event-ID` (header, atau `?last_event_id=`), replay `event: update` yang terlewat (maks. 200; lebih dari itu atau di luar log = snapshot). Setiap `event: update` membawa `id` = id stream Redis dan satu `RealtimeUpdate` (`type`, `event_id`, `at`, `location_id`, `status`, serta bila ada `ticket_id`, `ticket_number`, `booking_id`, `service_name`, `resource_name`, `is_recall`, `people_ahead`, `start_time`, `end_time`; tanpa nama/nomor pelanggan). Heartbeat `: ping` tiap 15 s.
- Satu langganan Pub/Sub per channel (dilepas bersama stream terakhir). Klien yang tidak menguras socket (buffer > 256 KiB) diputus dan menyambung ulang dengan `Last-Event-ID`. Stream berakhir paling lama setelah 1 jam atau saat token kedaluwarsa. Redis putus: semua stream ditutup, `/readyz` 503, stream baru 503 sampai Redis kembali. `SIGINT`/`SIGTERM`: semua stream diakhiri lalu server berhenti.
- Lingkungan: `JWT_SECRET` (sama dengan core-services), `REDIS_URL`; opsional `REALTIME_HOST`/`REALTIME_PORT` (`127.0.0.1:3300`: stream, `GET /healthz`, `GET /readyz`, `GET /metrics`), `REALTIME_HEARTBEAT_MS` (15000), `REALTIME_RETRY_MS` (3000), `REALTIME_MAX_CONNECTIONS` (5000), `REALTIME_MAX_CONNECTIONS_PER_TENANT` (100), `REALTIME_MAX_STREAM_SECONDS` (3600), `REALTIME_MAX_BUFFERED_BYTES` (262144), `REALTIME_SNAPSHOT_SIZE` (50), `REALTIME_REPLAY_LIMIT` (200), `LOG_LEVEL`.

```sh
pnpm --filter @antre/realtime-gateway build   # bundel Vite SSR ke apps/realtime-gateway/dist/server.js
pnpm --filter @antre/realtime-gateway start   # jalankan hasil build
pnpm --filter @antre/realtime-gateway dev     # build lalu jalankan dengan nilai dev dari .env.example
pnpm rt:test:integration                      # core-services tertanam + PostgreSQL + Redis nyata (proxy TCP untuk simulasi Redis mati)
```

`pnpm rt:test:integration` membuat database `antre_it_rt` dan memakai Redis database 12 (kunci `rt:*` dan `lock:slot:*` dihapus sebelum dan sesudah).

### Web staf/owner (`apps/web-staff`)

Aplikasi React untuk staf dan owner (pelanggan hanya lewat WhatsApp): login (JWT di memori dan `sessionStorage`, bukan `localStorage`; sesi berakhir saat token kedaluwarsa atau API membalas 401), pendaftaran tenant (`#/daftar`), dashboard operasional (`#/`: pilih lokasi, tiket per layanan, CALL_NEXT/RECALL/SERVE/COMPLETE/NO_SHOW sesuai role dan transisi sah, tiket manual untuk OWNER dan STAFF_CASHIER, reservasi hari ini, ringkasan menunggu/dilayani/selesai/rata-rata durasi, pembaruan live lewat SSE dengan reconnect otomatis) dan pengaturan owner (`#/pengaturan/<tab>`: layanan, resource beserta relasi layanan, jam operasional, mode layanan dan branding, staf, token kiosk, langganan dan kuota). Router hash buatan sendiri; dashboard, pengaturan, dan pendaftaran dimuat lazy (bundel awal ~110 KB, ~33 KB gzip). Tes memakai Vitest, jsdom, dan Testing Library.

Menjalankan: jalankan core-services (3000) dan realtime-gateway (3300), lalu `pnpm --filter @antre/web-staff dev` (http://localhost:5173). Dev dan `vite preview` mem-proxy `/api/v1/realtime` ke `REALTIME_PROXY_TARGET` (default `http://127.0.0.1:3300`) dan `/api` ke `API_PROXY_TARGET` (default `http://127.0.0.1:3000`) sehingga tanpa CORS. Env build: `VITE_API_URL` (origin API bila beda dari halaman; default origin yang sama) dan `VITE_REALTIME_URL` (origin gateway SSE; default origin yang sama). Tidak ada secret di bundel.

### Kiosk TV (`apps/web-staff/kiosk.html`)

Entry terpisah dari dashboard (bundle JS awal ~227 KB, ~72 KB gzip). Pasang sekali dengan membuka `kiosk.html?token=<token KIOSK_DISPLAY>`: token disimpan di `localStorage` dan dihapus dari address bar; lokasi dibaca dari token. Menampilkan loket/resource dengan nomor yang sedang dipanggil dan 6 panggilan terakhir, update live lewat SSE dengan reconnect otomatis (backoff 1-30 s, melanjutkan dari id terakhir). Setiap panggilan baru (termasuk panggilan ulang) membunyikan chime dua nada (WebAudio, tanpa file audio) lalu TTS bahasa Indonesia (`SpeechSynthesis`, `id-ID`, mis. "Nomor antrean A, dua belas, silakan menuju Loket 1."). Browser hanya mengizinkan audio setelah interaksi: ketuk tombol aktivasi sekali (sekaligus layar penuh), atau jalankan Chromium kiosk dengan `--autoplay-policy=no-user-gesture-required --kiosk`. Dev: `pnpm --filter @antre/web-staff dev` mem-proxy `/api/v1/realtime` ke `127.0.0.1:3300` (`REALTIME_PROXY_TARGET` mengganti target); gateway tidak mengirim header CORS, jadi Kiosk memakai origin yang sama (`VITE_REALTIME_URL` hanya untuk origin yang mengizinkan CORS).

## Deploy (S13)

Semua service dibangun dari satu `infra/docker/Dockerfile` multi-stage (konteks: root repo). Base `node:22.23.3-alpine3.24` dan `nginxinc/nginx-unprivileged:1.30.6-alpine` dipin ke tag minor plus digest (perbarui tag dan digest bersama-sama), pnpm 11.28.6 lewat Corepack, `pnpm install --frozen-lockfile` dengan cache BuildKit, dan `pnpm deploy --prod` memotong tree runtime tanpa devDependencies. Image runtime berjalan sebagai uid 1000 (web-staff uid 101), `NODE_ENV=production`, dengan `HEALTHCHECK`. `.dockerignore` menyingkirkan `docs/`, `.crew/`, `.env*`, `node_modules`, dan manifest.

| Target                | Isi                                                                                                                                                                | Port | Ukuran (disk) |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------- |
| `core-services`       | API Tenant & Auth, Catalog, Queue, Booking, Billing, Admin, `/internal/v1`                                                                                         | 3000 | 279 MB        |
| `notification-worker` | konsumer `notifications.wa`, `/healthz` `/readyz` `/metrics`                                                                                                       | 3100 | 249 MB        |
| `wa-channel`          | webhook Meta, konsumer `wa.inbound`                                                                                                                                | 3200 | 277 MB        |
| `realtime-gateway`    | SSE                                                                                                                                                                | 3300 | 278 MB        |
| `web-staff`           | statis (`index.html`, `kiosk.html`) di nginx-unprivileged; dipilih karena kecil, tanpa root, dan hanya perlu file statis (routing, TLS, dan header ada di Traefik) | 8080 | 91 MB         |
| `db-migrate`          | `node-pg-migrate up` sebagai `antre_migrator` (compose service one-shot / Kubernetes Job)                                                                          | -    | 254 MB        |

Ukuran termasuk layer base image (node alpine sekitar 238 MB di Docker Desktop; `node_modules` produksi service sekitar 36 MB).

```bash
docker build -f infra/docker/Dockerfile --target core-services -t antre/core-services:dev .
# atau semuanya: docker compose --env-file .env.prod -f docker-compose.prod.yml build
```

### Stack prod-like lokal (`docker-compose.prod.yml`)

Traefik v3 + semua image di atas + PostgreSQL/Redis/RabbitMQ pada jaringan internal `data` (tanpa akses keluar, tanpa port host). Hanya gateway yang membuka port host: `127.0.0.1:18080` (HTTP) dan `127.0.0.1:18443` (HTTPS dengan sertifikat self-signed bawaan Traefik). Port dev (35432, 36379, 35672, 45672) dan PostgreSQL lokal 5432 tidak dipakai.

```bash
cp .env.prod.example .env.prod          # ganti SEMUA CHANGE_ME; buat rahasia dengan: openssl rand -hex 32
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build --wait
bash infra/docker/smoke-prod.sh         # smoke test lewat gateway (butuh curl, node, openssl)
docker compose --env-file .env.prod -f docker-compose.prod.yml down -v   # hapus stack beserta volume (project antre-prod)
```

Urutan start: PostgreSQL, `db-roles` (satu kali; membuat 4 role dari `infra/docker/db-roles.sql` dengan password rahasia), `db-migrate` (satu kali), lalu service aplikasi, terakhir gateway. Routing ada di `infra/traefik/dynamic/antre.yml`:

- `/api/v1/auth|users|catalog|locations|queues|bookings|billing|tenants|admin|payments` ke core-services; `/api/v1/auth/login` dan `/register` dengan rate limit per IP (30/menit, burst 10).
- `/api/v1/realtime` ke realtime-gateway (SSE: tanpa kompresi dan buffering, tanpa write timeout).
- `/api/v1/channels/wa/` (webhook Meta; path sebenarnya di kode, bukan `/webhook/whatsapp`) ke wa-channel dengan flood guard longgar (300 req/dtk): spesifikasi mengecualikan webhook dari rate limit.
- `/`, `/index.html`, `/kiosk.html`, `/assets/` ke web-staff (dengan CSP). Daftar putih, bukan catch-all.
- `/internal/*`, `/healthz`, `/readyz`, `/metrics`, dan semua path lain: 404 di gateway (tidak ada router). Dibuktikan oleh `smoke-prod.sh`.
- Header keamanan: HSTS (hanya di HTTPS), `nosniff`, `frameDeny`, `Referrer-Policy`, `Permissions-Policy`.

Produksi dengan Traefik sendiri: pasang `certificatesResolvers` ACME (Let's Encrypt) pada `traefik.yml`, hapus entry point `web` atau jadikan redirect, dan atur `ipStrategy.depth` pada middleware rate limit bila ada load balancer di depan Traefik.

### Variabel dan rahasia wajib

Diisi di `.env.prod` (compose) atau Secret `antre-secrets` (k8s, templat: `infra/k8s/secret.template.yaml`). `JWT_SECRET`, `WA_CHANNEL_SERVICE_TOKEN`, `PAYMENT_CALLBACK_SECRET`, `WA_APP_SECRET`, dan `WA_VERIFY_TOKEN` wajib diganti dan tidak boleh berawalan `dev-only` (service menolak start saat `NODE_ENV=production`; teruji di image):

- `JWT_SECRET`, `WA_CHANNEL_SERVICE_TOKEN`, `PAYMENT_CALLBACK_SECRET`: min. 32 karakter. `WA_APP_SECRET`, `WA_VERIFY_TOKEN`: min. 16.
- Password database (`antre_migrator`, `antre_app`, `antre_platform_admin`, admin PostgreSQL), `REDIS_PASSWORD`, `RABBITMQ_PASSWORD`. Gunakan karakter aman URL (hex).
- `WA_ADAPTER=meta` memerlukan `META_WA_ACCESS_TOKEN` dan `META_WA_PHONE_NUMBER_ID`.

Rotasi: ganti nilai di `.env.prod` atau Secret, lalu restart pod/service pemakainya. `JWT_SECRET` dipakai core-services dan realtime-gateway sekaligus (restart keduanya; semua login dan token kiosk lama tidak berlaku lagi). `WA_CHANNEL_SERVICE_TOKEN` dipakai core-services dan wa-channel. `WA_APP_SECRET` harus sama dengan App Secret di dasbor Meta. Mengganti password role database: `ALTER ROLE ... PASSWORD`, perbarui URL di Secret, lalu restart.

### Migrasi database

Urutan produksi (spesifikasi 9.3): (1) administrator database membuat role sekali lewat `infra/docker/db-roles.sql` (`psql -v ON_ERROR_STOP=1 -f infra/docker/db-roles.sql "$DATABASE_ADMIN_URL"` dengan `ANTRE_*_PASSWORD` di environment), (2) jalankan Job `db-migrate` dan tunggu selesai, (3) baru terapkan manifest dengan tag image baru. Rollback satu langkah memakai image yang sama: `docker run --rm -e DATABASE_MIGRATOR_URL=... antre/db-migrate:TAG down --migrations-dir migrations --database-url-var DATABASE_MIGRATOR_URL`.

### Kubernetes / k3s (`infra/k8s`, kustomize)

```bash
kubectl kustomize infra/k8s/overlays/prod        # render
kubectl -n antre create secret generic antre-secrets --from-env-file=secrets.env   # atau apply templat yang sudah diisi
kubectl -n antre delete job db-migrate --ignore-not-found
kubectl apply -k infra/k8s/overlays/prod
kubectl -n antre wait --for=condition=complete job/db-migrate --timeout=300s
```

(Namespace `antre` dibuat oleh `kubectl apply -k`; buat dulu dengan `kubectl apply -f infra/k8s/base/namespace.yaml` bila Secret dibuat sebelum apply.)

- `base/`: namespace (Pod Security `restricted`), ConfigMap, Deployment + Service + HPA + PodDisruptionBudget per service, IngressRoute + Middleware Traefik (aturan sama dengan compose, tanpa `/internal`), NetworkPolicy (ingress hanya dari Traefik ke service publik; core hanya dari wa-channel; scrape dari namespace `monitoring`).
- Pod: non-root, rootfs read-only, `capabilities: drop [ALL]`, seccomp `RuntimeDefault`, probe `/readyz` (core: `/healthz`) dan `/healthz`, rolling update tanpa downtime (`maxUnavailable: 0`).
- Resource (node 2 vCPU / 4 GB): core 200m/256Mi (limit 1 CPU/512Mi), realtime dan wa-channel 100m, worker 50m, web-staff 20m.
- HPA: CPU rata-rata 70%, min 1 maks 4 (NFR-SCAL-01).
- `jobs/db-migrate/`: Job migrasi. `overlays/prod`: image GHCR (ganti `OWNER` dan tag `sha-<commit>`); PostgreSQL/Redis/RabbitMQ adalah layanan terkelola yang URL-nya ada di Secret. `overlays/dev`: salinan kecil PostgreSQL/Redis/RabbitMQ dalam cluster, Job `db-roles`, dan Secret placeholder; hanya untuk dev/uji.
- Validasi tanpa cluster: render kustomize lalu pipe ke kubeconform (`docker run --rm -i ghcr.io/yannh/kubeconform:latest -strict -summary -kubernetes-version 1.32.0 -schema-location default -schema-location <katalog CRD datreeio> -`; perintah lengkap di `ci.yml`, job `manifests`). `kubectl apply --dry-run=client` memerlukan API server dan belum dijalankan.

### Backup dan restore PostgreSQL

```bash
# backup (format custom; mencakup tabel, fungsi, dan RLS policy)
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres pg_dump -U postgres -d antre -Fc > antre-$(date +%F).dump
# restore ke database kosong (role harus sudah ada: jalankan db-roles dulu)
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres pg_restore -U postgres -d antre --clean --if-exists --no-owner < antre-YYYY-MM-DD.dump
```

Untuk PostgreSQL terkelola pakai snapshot/PITR penyedia. Redis dan RabbitMQ tidak perlu di-backup demi kebenaran data (sesi WA dan buffer notifikasi bersifat sementara, spesifikasi 9.5). Jalankan uji restore berkala.

### Runbook scaling node (NFR-SCAL-02, manual)

Pemicu: pod HPA `Pending` lebih dari 5 menit karena CPU/memori kurang. (1) Buat VM 2 vCPU / 4 GB; (2) pasang agent k3s dengan `K3S_URL=https://<server>:6443` dan `K3S_TOKEN` dari secrets (pin versi dengan `INSTALL_K3S_VERSION`); (3) `kubectl get nodes` harus menunjukkan node baru `Ready`; (4) setelah beban puncak, `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`, `kubectl delete node <node>`, lalu hapus VM. Scale pod manual darurat: `kubectl -n antre scale deploy/core-services --replicas=3` (HPA akan menyesuaikan lagi).

### Keterbatasan

- HPA hanya memakai CPU. Kriteria req/dtk per pod (> 50) memerlukan Prometheus (S14 menyediakan metrik `antre_http_requests_total`, dan manifest memberi anotasi scrape) + Prometheus Adapter, dan kriteria panjang antrean `notifications.wa` (> 100 per pod) memerlukan KEDA atau adapter metrik eksternal; keduanya belum dipasang.
- Forward-auth JWT dan rate limit per tenant di gateway belum ada: JWT diverifikasi oleh service sendiri, rate limit gateway hanya per IP dan per replika Traefik.
- Limiter login di core melihat IP Traefik (core belum memakai `trustProxy`), jadi kuncinya efektif per email.
- NetworkPolicy hanya ingress; egress ke layanan terkelola tidak dibatasi karena CIDR-nya bergantung penyedia.
- Belum diuji pada k3s sungguhan; CSP web belum diuji di browser sungguhan.
- `infra/k8s/overlays/dev/db-roles.sql` adalah salinan `infra/docker/db-roles.sql` (CI memeriksa keduanya sama).

## Observability (S14)

Overlay `docker-compose.observability.yml` menambahkan Prometheus, Grafana, dan `redis_exporter` di atas stack prod-like. Port hanya di `127.0.0.1` (Grafana 13000, Prometheus 19090; ubah lewat `GRAFANA_PORT`/`PROMETHEUS_PORT`), dan tidak ada route Traefik ke sana.

```bash
# .env.prod: isi juga GRAFANA_ADMIN_PASSWORD (lihat .env.prod.example)
docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.observability.yml up -d --build --wait
# Grafana http://127.0.0.1:13000 (admin / GRAFANA_ADMIN_PASSWORD), dashboard "Antre - Overview" (uid antre-overview) jadi halaman awal
# Prometheus http://127.0.0.1:19090/targets (8 target: 4 service, traefik, rabbitmq, rabbitmq-queues, redis)
```

- Target scrape (`infra/observability/prometheus.yml`): `core-services:3000`, `notification-worker:3100`, `wa-channel:3200`, `realtime-gateway:3300` (semuanya `/metrics`), Traefik (`gateway:8082`, entry point internal `traefik`, label per service), RabbitMQ (plugin `rabbitmq_prometheus` bawaan image, port 15692, termasuk `/metrics/detailed` untuk kedalaman antrean per queue), dan `redis-exporter`.
- `core-services` kini punya `/metrics` buatan sendiri (tanpa library klien): `antre_http_requests_total{method,route,status}`, histogram `antre_http_request_duration_seconds{method,route,status_class}` (bucket 5 ms sampai 5 dtk, ada bucket 0,2), `antre_events_published_total{event_type}` (tiket dibuat/dipanggil, reservasi, `billing.quota.warning/exceeded`), dan `antre_db_pool_connections{pool,state}`. Label `route` adalah pola rute (`/api/v1/queues/tickets/:id/actions`, rute tak dikenal menjadi `unmatched`), tanpa tenant atau pengguna sebagai label, dan jumlah deret dibatasi 500. `/metrics` tidak dirutekan Traefik (404 di gateway, dicek `smoke-prod.sh`); di k3s NetworkPolicy `allow-prometheus-scrape` hanya mengizinkan namespace `monitoring`.
- Alert (`infra/observability/alerts.yml`, 7 aturan): `ServiceDown`, `HighErrorRate` (5xx > 1% selama 5 menit), `HighLatencyP95` dan `GatewayHighLatencyP95` (> 200 ms), `NotificationDeadLetterQueueNotEmpty` (DLQ bertambah atau berisi), `RealtimeRedisNotReady`, `DbPoolSaturated`. Alertmanager belum dipasang: aturan hanya dievaluasi dan terlihat di Prometheus/Grafana.
- Dashboard (`infra/observability/grafana/dashboards/antre-overview.json`, 23 panel): laju request, p95, dan error per route/service; tiket dibuat/dipanggil/selesai, reservasi, peringatan kuota; notifikasi terkirim/retry/DLQ, webhook WA, balasan tanpa tenant; koneksi SSE, RabbitMQ (`notifications.wa`), Redis, pool DB; status target. Datasource dan dashboard diprovisi dari berkas (read-only di UI).
- Validasi: `docker run --rm -v "$PWD/infra/observability/prometheus.yml:/etc/prometheus/prometheus.yml:ro" -v "$PWD/infra/observability/alerts.yml:/etc/prometheus/rules/alerts.yml:ro" --entrypoint promtool prom/prometheus:v3.15.1 check config /etc/prometheus/prometheus.yml` (job CI `observability` menjalankannya; di Git Bash tambahkan `MSYS_NO_PATHCONV=1`).
- k3s: Deployment `core-services`, `notification-worker`, `wa-channel`, dan `realtime-gateway` memakai anotasi `prometheus.io/scrape|port|path`. ServiceMonitor tidak disertakan; pasang Prometheus di namespace `monitoring` (mis. kube-prometheus-stack) dengan scrape berbasis anotasi. Itu juga prasyarat HPA berbasis req/dtk (Prometheus Adapter).
- Image dipin tag+digest: `prom/prometheus:v3.15.1`, `grafana/grafana:13.0.11`, `oliver006/redis_exporter:v1.94.0`.

## Uji beban (k6, S14)

Skrip di `load/` (`antre.js`, `lib.js`, `run.sh`); k6 berjalan lewat image `grafana/k6:2.3.0` (tanpa instalasi lokal) di jaringan `edge` stack compose agar bisa mencapai gateway (`/api/v1/*`) dan `core-services` langsung (`/internal/v1`, tidak dirutekan gateway). Setiap run membuat 6 tenant sekali pakai (register, katalog, upgrade ke `PAID_LOCATION` lewat checkout dan callback HMAC agar kuota 100 tiket FREE tidak mengganggu).

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.observability.yml up -d --build --wait
PROFILE=smoke bash load/run.sh .env.prod                 # 30 dtk
PROFILE=normal bash load/run.sh .env.prod                # quiet | normal | peak
SCENARIOS=holds PROFILE=smoke bash load/run.sh .env.prod # mixed,login,holds,sse,webhook
# project compose lain: COMPOSE_PROJECT_NAME=antre-s14 bash load/run.sh .env.s14
# (smoke-prod.sh juga membaca log lewat project compose: ekspor COMPOSE_PROJECT_NAME yang sama)
```

Skenario: `mixed` (a+b: 40% baca dashboard, 15% buat tiket lewat `/internal/v1` dengan token servis, 45% staf CALL_NEXT lalu SERVE dan COMPLETE; ramp bertahap `ramping-arrival-rate`: quiet 5 lalu 10 req/dtk, normal 30 lalu 50, peak 100 lalu 150), `login` (20 login/menit), `holds` (c: 400 percobaan hold, 20 sekaligus pada slot yang sama dengan 2 resource; slot boleh diterima paling banyak 2 kali, dan teardown memeriksa kalender: nol double booking), `sse` (d: 25 koneksi SSE selama 20 dtk), `webhook` (5 webhook Meta bertanda tangan per dtk). Ambang: p95 < 200 ms untuk request API dan tiap endpoint, hold, dan webhook; login p95 < 500 ms (scrypt sengaja lambat); respons tak terduga < 1%; `antre_double_bookings` = 0.

Hasil nyata pada laptop (Windows 11, Docker Desktop 12 vCPU dan 8 GB dibagi dengan k6, Prometheus, Grafana; satu replika per service, bukan 2 node 2 vCPU), 6 tenant, `kind:api` (semua endpoint API bersama):

| Profil                | Rata-rata req/dtk  | p50     | p95     | p99      | Error | Hold p95 | Login p95 |
| --------------------- | ------------------ | ------- | ------- | -------- | ----- | -------- | --------- |
| quiet (5 sampai 10)   | 14,8               | 10,4 ms | 22,9 ms | 35,0 ms  | 0%    | 148 ms   | 274 ms    |
| normal (30 sampai 50) | 46,3               | 10,3 ms | 21,5 ms | 30,6 ms  | 0%    | 169 ms   | 342 ms    |
| peak (100 sampai 150) | 134,4 (puncak 150) | 17,3 ms | 62,4 ms | 114,4 ms | 0%    | 144 ms   | 411 ms    |

Run peak lengkap (semua skenario, 19.140 request): 0 dari 19.140 gagal, 2.799 tiket dibuat dan 2.793 dipanggil, 40 hold diterima (20 slot x 2 resource) dan 360 ditolak 409, `antre_double_bookings` 0, webhook p95 6,8 ms, SSE 25 koneksi terbuka 20 dtk. Selama peak: `core-services` sekitar 63% CPU, PostgreSQL sekitar 280% CPU (bottleneck mesin ini), RabbitMQ dan Traefik rendah.

Temuan:

- Satu antrean (satu lokasi dan layanan) diserialkan oleh baris `ticket_counters` (mutex per antrean untuk FIFO, §6.3). Dengan SEMUA beban pada satu lokasi, throughput berhenti di sekitar 80 sampai 105 req/dtk dan p95 melonjak ke 6 sampai 19 dtk (pool DB 10 koneksi penuh, ratusan permintaan menunggu). Beban NFR-LOAD-01 secara nyata tersebar di banyak lokasi; dengan 6 tenant ambangnya lulus pada profil peak. Perbaikan kecil yang dibuat: `reserveQuota` (baris `usage_counters`, titik panas kedua) dipindah ke akhir transaksi pembuatan tiket sehingga kunci ditahan lebih singkat (satu antrean: 82 menjadi 105 req/dtk; tes integrasi core hijau). Batas per antrean bukan perubahan kecil: butuh redesain (mis. sequence di luar transaksi) dan dicatat sebagai keterbatasan.
- Menambah replika `core-services` (2 replika) tidak menaikkan throughput satu antrean, karena bottleneck ada di database, bukan CPU Node.
- Hold 20 sekaligus pada slot yang sama: p95 sekitar 150 ms (diserialkan advisory lock slot); lulus tetapi paling dekat ke ambang.
- Login p95 270 sampai 410 ms oleh scrypt (sengaja); ambangnya dilonggarkan khusus login.
- `GET /queues/tickets` mengembalikan semua tiket aktif lokasi tanpa paginasi; dengan antrean ribuan tiket (uji awal tanpa SERVE/COMPLETE) payload dan CPU PostgreSQL membesar. Tidak dibatasi di S14 (antrean nyata kecil).
- Tidak ada indeks atau N+1 yang terbukti jadi penyebab utama; `expireStaleTickets` (UPDATE tiap operasi antrean) memindai tiket aktif per lokasi dan perlu dipantau bila antrean besar.

## Uji E2E (S15)

`pnpm e2e` membangun core-services, notification-worker, wa-channel, dan realtime-gateway, lalu menjalankan tes journey pelanggan di `e2e/` (paket privat `@antre/e2e`, Vitest, tanpa dependensi tambahan; HTTP dan SSE memakai `fetch` bawaan Node).

Prasyarat: PostgreSQL, Redis, dan RabbitMQ (dengan management API) yang bisa dijangkau lewat variabel yang sama dengan tes integrasi lain (`DATABASE_ADMIN_URL`, `DATABASE_MIGRATOR_URL`, `DATABASE_APP_URL`, `DATABASE_PLATFORM_ADMIN_URL`, `REDIS_URL`, `RABBITMQ_URL`, `RABBITMQ_MANAGEMENT_URL`; default `.env.example` = stack dev, variabel shell menang). Host harus `127.0.0.1` atau `localhost`.

```sh
docker compose -f docker-compose.dev.yml up -d --wait   # atau kontainer sementara + variabel env di atas
pnpm e2e                                                # sekitar 40 detik termasuk build
E2E_KEEP_LOGS=1 pnpm e2e                                # simpan log service (JSON) di folder temp bila gagal
```

Harness (`e2e/src/global-setup.ts`): membuat database `antre_e2e` (peran + migrasi) dan vhost RabbitMQ `antre_e2e` yang bersih, mengosongkan Redis database 11 (stack dev memakai 0; tes lain 12 dan 13), lalu men-spawn empat service dari `dist` sebagai proses anak pada port acak dengan rahasia acak (NODE_ENV=test, adapter WA `sandbox`) dan menunggu `/readyz`. Semua dihapus di teardown (Windows dan Linux), jadi aman dijalankan berdampingan dengan stack dev. Balasan WhatsApp dibaca dari log JSON worker (adapter sandbox mencetak tiap pesan; nomor di log disamarkan sehingga tiap pelanggan uji diberi 4 digit akhir unik). Service terhubung ke RabbitMQ lewat proxy TCP milik harness; memutus proxy itu mensimulasikan broker mati tanpa menyentuh RabbitMQ bersama.

| Berkas (`e2e/tests`)    | Journey                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-owner-onboarding`   | register (duplikat 409), login (salah 401), layanan tanpa dan dengan DP (validasi 400), resource, relasi, jam seharian, mode BOTH, staf CALLER/CASHIER (batas role), token kiosk (stream ya, API staf tidak)                                                      |
| `02-walk-in`            | WA `ANTRE <slug> <kode>` → menu → layanan → tiket; balasan, tiket di API staf, SSE staf dan kiosk `created` tanpa PII; CALL_NEXT (kiosk + pesan dipanggil), RECALL, SERVE, COMPLETE; STATUS dan BATAL tanpa sesi Redis                                            |
| `03-reservation`        | reservasi layanan ber-DP sampai hold, callback QRIS ber-HMAC (palsu 401, nominal salah membatalkan, duplikat idempoten) → CONFIRMED + pesan; pelanggan lain tidak bisa mengambil slot yang sama (menu dan hold internal 409); batal membebaskan slot              |
| `04-quota-billing`      | 100 tiket FREE lewat endpoint internal, ke-101 ditolak 402 (staf dan WA sopan, admin diberi tahu), checkout owner, callback langganan ber-HMAC → ACTIVE → tiket lanjut                                                                                            |
| `05-security-isolation` | tenant kedua tidak melihat atau mengubah data tenant pertama (API dan SSE), JWT palsu 401 (API dan stream), tanda tangan webhook salah 401, callback pembayaran tanpa tanda tangan 401, `/internal` tertutup untuk token pengguna dan tidak ada di service publik |
| `06-resilience`         | broker diputus: tiket tetap jadi, webhook 503, setelah pulih pesan terkirim dan webhook normal; koneksi PostgreSQL di-terminate 3 kali: core dan worker tidak crash dan pulih (regresi BUG-1)                                                                     |

Tidak diotomatiskan di sini: dashboard dan kiosk di browser (chime/TTS), Super Admin suspend, pengingat booking terjadwal, dan menghentikan RabbitMQ/PostgreSQL sungguhan (lihat `docs/manual-testing.md` dan `docs/checklist-pengujian.md`).

## CI

`.github/workflows/ci.yml` berjalan pada pull request ke `main` dan push ke `main` dengan enam job (`check`, `db-integration`, `e2e`, `images`, `manifests`, `observability`); `.github/workflows/smoke.yml` terpisah (manual atau Senin 03:00 UTC):

- `check`: install (`--frozen-lockfile`), cek format, lint, typecheck, test, dan build core-services, notification-worker, wa-channel, realtime-gateway, serta web-staff.
- `db-integration`: PostgreSQL 16 (port host 35432 dan kredensial dev yang sama dengan `docker-compose.dev.yml`), Redis 8 (port host 36379, sesuai `REDIS_URL` di `.env.example`), dan RabbitMQ 4.3 dengan management (port host 35672 dan 45672, sesuai `RABBITMQ_URL` dan `RABBITMQ_MANAGEMENT_URL`) sebagai service container, lalu `pnpm db:setup`, rollback dan terapkan ulang migrasi terakhir, `pnpm db:test:integration`, `pnpm core:test:integration` (tes API Tenant & Auth, Catalog, Queue, Booking, callback pembayaran, langganan dan konsol Super Admin, publish saat broker mati, endpoint internal WhatsApp), `pnpm notif:test:integration`, `pnpm wa:test:integration`, lalu `pnpm rt:test:integration`.
- `e2e`: service container PostgreSQL/Redis/RabbitMQ seperti `db-integration`, lalu `pnpm e2e` (build empat service dan jalankan semua journey).
- `images`: build semua image (target Dockerfile) dengan cache GitHub Actions, tanpa push.
- `manifests`: render kustomize base/dev/prod, validasi dengan kubeconform (termasuk CRD Traefik), `docker compose config` untuk berkas dev, prod, dan prod + observability, dan cek salinan `db-roles.sql`.
- `observability`: `promtool check config` (termasuk aturan alert) lewat image `prom/prometheus` dan validasi JSON dashboard Grafana.

`.github/workflows/smoke.yml` (`workflow_dispatch` atau terjadwal) membangun stack prod-like plus overlay observability dengan rahasia acak yang dibuat di runner (tanpa secret repositori), menjalankan `smoke-prod.sh`, memeriksa semua target Prometheus `up`, lalu k6 smoke 30 detik (`mixed,holds,sse`). Sintaks semua workflow dicek dengan `rhysd/actionlint:1.7.12` (`docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12`).

`.github/workflows/release.yml` (tag `v*` atau manual) mendorong image ke GHCR dengan tag `sha-<commit>` dan tag versi; nonaktif sampai variabel repositori `RELEASE_ENABLED=true` diset, dan tanpa secret tambahan (memakai `GITHUB_TOKEN`).

## Konvensi

- TypeScript strict dan ESM (`"type": "module"`) di semua paket. TypeScript dipin ke 6.0 karena typescript-eslint belum mendukung TypeScript 7.
- Akhir baris LF (`.gitattributes`, `.editorconfig`).
- Dokumentasi berbahasa Indonesia; kode dan identifier berbahasa Inggris.
