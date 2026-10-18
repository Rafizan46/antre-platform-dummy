# infra/k8s

Manifest k3s/Kubernetes (kustomize): `base/` (workload, HPA, PDB, IngressRoute Traefik, NetworkPolicy), `jobs/db-migrate/` (Job migrasi), `overlays/prod` (image GHCR, layanan data terkelola), `overlays/dev` (PostgreSQL/Redis/RabbitMQ kecil dalam cluster, hanya dev/uji), dan `secret.template.yaml` (templat Secret, tidak ikut kustomize). Cara pakai, urutan migrasi, backup, dan runbook scaling node: bagian Deploy di `README.md` root (spesifikasi 9.1 sampai 9.5). Pemilik: Rafa Abdussalam (spesifikasi 10).
