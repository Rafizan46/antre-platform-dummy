# Antre Platform

Monorepo platform SaaS antrean virtual dan reservasi slot multi-tenant untuk UMKM (Tugas Besar Komputasi Layanan, Kelompok 09). Dokumen desain (`docs/`) disimpan lokal dan tidak ikut di-commit.

## Struktur

| Path                       | Isi                                                               | Status                   |
| -------------------------- | ----------------------------------------------------------------- | ------------------------ |
| `apps/gateway`             | Konfigurasi API Gateway Traefik (bukan paket Node)                | placeholder              |
| `apps/core-services`       | Tenant & Auth, Catalog, Queue, Booking (Fastify)                  | kerangka, `GET /healthz` |
| `apps/wa-channel`          | WA Channel Service: webhook Meta dan mesin percakapan (Fastify)   | kerangka, `GET /healthz` |
| `apps/realtime-gateway`    | Realtime SSE Gateway (Fastify)                                    | kerangka, `GET /healthz` |
| `apps/notification-worker` | Konsumer RabbitMQ pengirim pesan WhatsApp                         | kerangka                 |
| `apps/web-staff`           | Web staff: Dashboard, Konsol Super Admin, Kiosk TV (React + Vite) | kerangka                 |
| `packages/shared-types`    | `@antre/shared-types`: enum status dan role                       | kosong                   |
| `packages/event-contracts` | `@antre/event-contracts`: envelope dan katalog event              | kosong                   |
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

Role database aplikasi (`antre_migrator`, `antre_app`, dan lainnya), topologi RabbitMQ (`antre.events` dan queue-nya), mock WhatsApp Cloud API, dan simulator pembayaran QRIS belum ada; semuanya ditambahkan di workstream terkait.

## CI

`.github/workflows/ci.yml` berjalan pada pull request ke `main` dan push ke `main`: install (`--frozen-lockfile`), cek format, lint, typecheck, dan test.

## Konvensi

- TypeScript strict dan ESM (`"type": "module"`) di semua paket. TypeScript dipin ke 6.0 karena typescript-eslint belum mendukung TypeScript 7.
- Akhir baris LF (`.gitattributes`, `.editorconfig`).
- Dokumentasi berbahasa Indonesia; kode dan identifier berbahasa Inggris.
