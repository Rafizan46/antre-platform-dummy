# Antre Platform

Monorepo platform SaaS antrean virtual dan reservasi slot multi-tenant untuk UMKM (Tugas Besar Komputasi Layanan, Kelompok 09). Dokumen desain (`docs/`) disimpan lokal dan tidak ikut di-commit.

## Struktur

| Path                       | Isi                                                               | Status                   |
| -------------------------- | ----------------------------------------------------------------- | ------------------------ |
| `apps/gateway`             | Konfigurasi API Gateway Traefik (bukan paket Node)                | placeholder              |
| `apps/core-services`       | Tenant & Auth: register, login, staf, settings (Fastify)          | aktif                    |
| `apps/wa-channel`          | WA Channel Service: webhook Meta dan mesin percakapan (Fastify)   | kerangka, `GET /healthz` |
| `apps/realtime-gateway`    | Realtime SSE Gateway (Fastify)                                    | kerangka, `GET /healthz` |
| `apps/notification-worker` | Konsumer RabbitMQ pengirim pesan WhatsApp                         | kerangka                 |
| `apps/web-staff`           | Web staff: Dashboard, Konsol Super Admin, Kiosk TV (React + Vite) | kerangka                 |
| `packages/shared-types`    | `@antre/shared-types`: enum status dan role                       | aktif                    |
| `packages/event-contracts` | `@antre/event-contracts`: envelope dan katalog event              | aktif                    |
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

Topologi RabbitMQ (`antre.events` dan queue-nya), mock WhatsApp Cloud API, dan simulator pembayaran QRIS belum ada; semuanya ditambahkan di workstream terkait. Role dan skema database ada di `packages/db` (bagian berikut).

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

## Tenant & Auth (`apps/core-services`)

Endpoint `/api/v1`: `POST /auth/register`, `POST /auth/login`, `GET|POST /users`, `PATCH /users/:id` (OWNER), dan `GET|PATCH /tenants/me/settings`. Service terhubung ke PostgreSQL sebagai `antre_app` (`DATABASE_APP_URL`) dan membaca `JWT_SECRET` dari lingkungan (minimal 32 karakter; nilai `dev-only...` di `.env.example` hanya untuk dev dan ditolak saat `NODE_ENV=production`). Belum ada entry server (`listen`); itu menyusul di workstream deploy.

```sh
pnpm core:test:integration   # tes API + DB di database sementara antre_it_core (butuh Docker)
```

`pnpm -r test` hanya menjalankan tes unit, jadi tetap hijau tanpa Docker.

## CI

`.github/workflows/ci.yml` berjalan pada pull request ke `main` dan push ke `main` dengan dua job:

- `check`: install (`--frozen-lockfile`), cek format, lint, typecheck, dan test.
- `db-integration`: PostgreSQL 16 sebagai service container (port host 35432 dan kredensial dev yang sama dengan `docker-compose.dev.yml`), lalu `pnpm db:setup`, rollback dan terapkan ulang migrasi terakhir, `pnpm db:test:integration`, lalu `pnpm core:test:integration` (tes API Tenant & Auth).

## Konvensi

- TypeScript strict dan ESM (`"type": "module"`) di semua paket. TypeScript dipin ke 6.0 karena typescript-eslint belum mendukung TypeScript 7.
- Akhir baris LF (`.gitattributes`, `.editorconfig`).
- Dokumentasi berbahasa Indonesia; kode dan identifier berbahasa Inggris.
