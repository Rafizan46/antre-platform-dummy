# apps/gateway

API Gateway Antre adalah Traefik (spesifikasi 5.1, 9.1, 9.2), bukan aplikasi Node. Folder ini bukan paket pnpm (`pnpm-workspace.yaml` mengecualikannya) dan hanya berisi catatan; konfigurasi Traefik ada di:

- `infra/traefik/traefik.yml` dan `infra/traefik/dynamic/antre.yml`: gateway stack prod-like lokal (`docker-compose.prod.yml`).
- `infra/k8s/base/ingress.yaml`: IngressRoute dan Middleware Traefik untuk k3s (aturan routing yang sama).

Routing, rate limit per IP, header keamanan, dan penutupan `/internal/*` dijelaskan di bagian Deploy pada `README.md` root. Forward-auth JWT dan rate limit per tenant di gateway belum diimplementasikan (JWT diverifikasi oleh service). Pemilik: Julius Arthur (spesifikasi 10).
