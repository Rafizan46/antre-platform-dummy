# apps/gateway

API Gateway Antre adalah Traefik (spesifikasi §5.1, §9.1, §9.2), bukan aplikasi Node. Karena itu folder ini bukan paket pnpm: tidak ada `package.json`, dan `pnpm-workspace.yaml` mengecualikannya (`!apps/gateway`).

Folder ini nantinya berisi konfigurasi gateway: routing `/api/v1/*` ke service, verifikasi JWT forward-auth, rate limiting (kecuali webhook WhatsApp), dan pemblokiran `/internal/*`. Format konfigurasinya (konfigurasi dinamis Traefik dan/atau resource Traefik di k3s) diputuskan di workstream gateway. Pemilik: Julius Arthur (§10).

Belum ada konfigurasi pada S01.
