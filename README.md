# Antre Platform

Monorepo platform SaaS antrean virtual dan reservasi slot multi-tenant untuk UMKM (Tugas Besar Komputasi Layanan, Kelompok 09). Dokumen desain (`docs/`) disimpan lokal dan tidak ikut di-commit.

## Struktur

| Path                       | Isi                                                               | Status                   |
| -------------------------- | ----------------------------------------------------------------- | ------------------------ |
| `apps/gateway`             | Konfigurasi API Gateway Traefik (bukan paket Node)                | placeholder              |
| `apps/core-services`       | Tenant & Auth, Catalog, Queue (Fastify)                           | aktif                    |
| `apps/wa-channel`          | WA Channel Service: webhook Meta dan mesin percakapan (Fastify)   | kerangka, `GET /healthz` |
| `apps/realtime-gateway`    | Realtime SSE Gateway (Fastify)                                    | kerangka, `GET /healthz` |
| `apps/notification-worker` | Konsumer RabbitMQ pengirim pesan WhatsApp                         | aktif                    |
| `apps/web-staff`           | Web staff: Dashboard, Konsol Super Admin, Kiosk TV (React + Vite) | kerangka                 |
| `packages/shared-types`    | `@antre/shared-types`: enum status dan role                       | aktif                    |
| `packages/event-contracts` | `@antre/event-contracts`: envelope dan katalog event              | aktif                    |
| `packages/messaging`       | `@antre/messaging`: topologi RabbitMQ, koneksi, publisher event   | aktif                    |
| `packages/db`              | `@antre/db`: migrasi SQL (node-pg-migrate), role dev, tes RLS     | aktif                    |
| `infra/k8s`                | Manifest k3s                                                      | placeholder              |
| `.github/workflows`        | CI GitHub Actions                                                 | aktif                    |

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

Topologi RabbitMQ (`antre.events` dan queue `notifications.*`) dideklarasikan otomatis oleh core-services dan Notification Worker saat terhubung (bagian Notification Worker). Mock WhatsApp Cloud API berupa adapter sandbox di dalam worker; simulator pembayaran QRIS dan queue `wa.inbound` belum ada dan ditambahkan di workstream terkait. Role dan skema database ada di `packages/db` (bagian berikut).

## Database (`packages/db`)

Skema PostgreSQL (spesifikasi §6) dikelola dengan migrasi SQL murni node-pg-migrate di `packages/db/migrations`. Paket ini tidak berisi kode runtime; service nanti terhubung sendiri sebagai `antre_app`.

Dari nol, setelah lingkungan Docker `up`:

```sh
pnpm db:setup              # = pnpm db:bootstrap && pnpm db:migrate
pnpm db:test:integration   # tes integrasi di database sementara antre_it
```

- `pnpm db:bootstrap` (koneksi `DATABASE_ADMIN_URL`, superuser `postgres`): khusus dev dan CI. Menjalankan `packages/db/bootstrap`: role `antre_migrator`, `antre_app`, `antre_platform_admin`, `antre_definer` dengan password placeholder dev, plus hak `CREATE` di schema `public`. Di produksi langkah ini dikerjakan admin database (§6.1).
- `pnpm db:migrate` (koneksi `DATABASE_MIGRATOR_URL`): menerapkan migrasi yang belum jalan, yaitu tabel, RLS, policy, GRANT, 7 fungsi `SECURITY DEFINER`, dan seed paket `FREE` dan `PAID_LOCATION`.
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
- Lokasi: `GET|POST /locations`, `PATCH /locations/:id` (tulis: OWNER).
- Katalog: `GET|POST /catalog/services`, `PATCH /catalog/services/:id`, `GET|POST /catalog/resources`, `PATCH /catalog/resources/:id`, `GET|PUT /catalog/locations/:location_id/operating-hours`.
- Antrean: `POST|GET /queues/tickets`, `POST /queues/tickets/call-next`, `POST /queues/tickets/:id/actions` (RECALL, SERVE, COMPLETE, NO_SHOW).
- Reservasi: `GET /bookings?location_id&date` (kalender slot; OWNER, STAFF_CALLER, STAFF_CASHIER), `POST /bookings/:id/actions` (COMPLETE, NO_SHOW, CANCEL; OWNER, STAFF_CASHIER).
- Pembayaran (tanpa JWT, dipanggil penyedia QRIS): `POST /payments/qris/callback`. Body JSON mentah ditandatangani HMAC-SHA256 dengan `PAYMENT_CALLBACK_SECRET`, dikirim di header `X-Antre-Signature: sha256=<hex>`; callback diproses idempoten per `payment_ref`.
- Internal untuk WhatsApp Channel Service (`/internal/v1`, jangan dirutekan lewat gateway publik): `POST /queues/tickets`, `GET /queues/tickets/active`, `POST /queues/tickets/:id/cancel`, `GET /catalog/services`, `GET /bookings/available-slots`, `POST /bookings/holds`, `GET /bookings/active`, `POST /bookings/:id/cancel`. Header `Authorization: Bearer <WA_CHANNEL_SERVICE_TOKEN>` dan `X-Antre-Tenant-Id`.

Service terhubung ke PostgreSQL sebagai `antre_app` (`DATABASE_APP_URL`) dan membaca `JWT_SECRET`, `WA_CHANNEL_SERVICE_TOKEN`, dan `PAYMENT_CALLBACK_SECRET` dari lingkungan (masing-masing minimal 32 karakter; nilai `dev-only...` di `.env.example` hanya untuk dev dan ditolak saat `NODE_ENV=production`). Host dan port listen dari `CORE_SERVICES_HOST` (default `127.0.0.1`) dan `CORE_SERVICES_PORT` (default `3000`). Hold slot reservasi memakai lock Redis (`REDIS_URL`, mis. `redis://127.0.0.1:36379`; key `lock:slot:<resource_id>:<slot_start>` selama 5 menit, dilepas dengan skrip Lua compare-and-delete). Jika Redis mati, hold tetap berjalan dan dijaga unique index `bookings_active_slot_key` (bentrok menjadi 409 `SLOT_TAKEN`); server tidak berhenti. Dua job berjalan tiap menit di server: kedaluwarsa hold (EXPIRED dan lepas lock) dan pengingat 30 menit sebelum jadwal (`booking.reservation.reminder_due`); aman untuk beberapa replika. Event `queue.*`, `booking.*`, dan `billing.quota.*` dipublikasikan ke exchange `antre.events` (RabbitMQ, `RABBITMQ_URL`) setelah commit, dengan publisher confirms dan pesan persistent. Jika RabbitMQ mati, request tetap berhasil: event disimpan di buffer memori (maks. 1000, terlama dibuang bila penuh) dan dikirim berurutan setelah koneksi pulih; buffer hilang bila proses berhenti saat broker mati (tanpa outbox, lihat spesifikasi §9.5).

```sh
pnpm --filter @antre/core-services build   # bundel Vite SSR ke apps/core-services/dist/server.js
pnpm --filter @antre/core-services start   # jalankan hasil build (butuh DATABASE_APP_URL, REDIS_URL, RABBITMQ_URL, JWT_SECRET, WA_CHANNEL_SERVICE_TOKEN, PAYMENT_CALLBACK_SECRET)
pnpm --filter @antre/core-services dev     # build lalu jalankan dengan nilai dev dari .env.example
```

```sh
pnpm core:test:integration   # tes API + DB di database sementara antre_it_core (butuh Docker: PostgreSQL dan Redis dari docker-compose.dev.yml)
```

`pnpm -r test` hanya menjalankan tes unit, jadi tetap hijau tanpa Docker.

## Notification Worker (`apps/notification-worker`)

Konsumer queue `notifications.wa` (spesifikasi §3.5, §7.1): memetakan event ke template WhatsApp, mengirim lewat `WhatsAppAdapter`, dan mencatat setiap pesan ber-tenant di `notification_logs` (koneksi `antre_app`, tenant dari envelope dengan `SET LOCAL`). `wa.status.received` memperbarui `delivery_status` lewat `app_wa_update_delivery_status`.

- Topologi (dideklarasikan idempoten oleh setiap service saat terhubung, `packages/messaging/src/topology.ts`): exchange topic `antre.events`; queue `notifications.wa` terikat ke 12 routing key bertanda `notifications.wa` di katalog §7.1; queue tunda `notifications.wa.retry.1`/`.2`/`.3` (TTL per pesan 5 s, 25 s, 125 s, lalu kembali ke `notifications.wa`); `notifications.dlq` untuk audit (RabbitMQ Management).
- Kegagalan: `unavailable` (jaringan, HTTP 5xx) dan `rate_limited` (HTTP 429, kode rate limit Cloud API) di-retry 3 kali lalu masuk DLQ (`delivery_status = DLQ`); `rejected` (4xx lain, mis. template tidak ada) langsung ke DLQ; pesan yang bukan event valid ditolak broker ke DLQ. Header DLQ: `x-antre-retry`, `x-antre-error`, `x-antre-error-kind`, `x-antre-failed-at`, `x-antre-routing-key`.
- Idempoten per `event_id`: baris log diklaim dengan `INSERT ... ON CONFLICT` (unik `(tenant_id, event_id)`, migrasi `1792285200000_notification-log-event-key`) dan `SELECT ... FOR UPDATE`; event duplikat atau redelivery tidak dikirim dua kali. Balasan `wa.reply.requested` tanpa tenant tidak dicatat di tabel (hanya log aplikasi dan metrik `antre_wa_untenanted_replies_total`).
- Template (nama dan teks yang diajukan ke Meta, bahasa `id`): `apps/notification-worker/src/templates.ts`. Sapaan (`branding.wa_greeting`), label resource, nama lokasi, dan zona waktu (WIB/WITA/WIT) dibaca dari database tenant.
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

## CI

`.github/workflows/ci.yml` berjalan pada pull request ke `main` dan push ke `main` dengan dua job:

- `check`: install (`--frozen-lockfile`), cek format, lint, typecheck, test, dan build core-services serta notification-worker.
- `db-integration`: PostgreSQL 16 (port host 35432 dan kredensial dev yang sama dengan `docker-compose.dev.yml`), Redis 8 (port host 36379, sesuai `REDIS_URL` di `.env.example`), dan RabbitMQ 4.3 dengan management (port host 35672 dan 45672, sesuai `RABBITMQ_URL` dan `RABBITMQ_MANAGEMENT_URL`) sebagai service container, lalu `pnpm db:setup`, rollback dan terapkan ulang migrasi terakhir, `pnpm db:test:integration`, `pnpm core:test:integration` (tes API Tenant & Auth, Catalog, Queue, Booking, callback pembayaran, publish saat broker mati), lalu `pnpm notif:test:integration`.

## Konvensi

- TypeScript strict dan ESM (`"type": "module"`) di semua paket. TypeScript dipin ke 6.0 karena typescript-eslint belum mendukung TypeScript 7.
- Akhir baris LF (`.gitattributes`, `.editorconfig`).
- Dokumentasi berbahasa Indonesia; kode dan identifier berbahasa Inggris.
