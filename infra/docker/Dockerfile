# syntax=docker/dockerfile:1.7
#
# One multi-stage Dockerfile for every deployable of the monorepo (spec section 9.3). Build with the
# repo root as context:
#   docker build -f infra/docker/Dockerfile --target <target> -t antre/<target>:dev .
# Targets: core-services, notification-worker, wa-channel, realtime-gateway, web-staff, db-migrate.
#
# Base images are pinned to a minor tag plus digest. Refresh tag and digest together.
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:782bb89768cc87b7f95c18b95baa1af250e5d451f26794f59363540161147c01
ARG PNPM_VERSION=11.28.6

# ---- deps: install every workspace dependency from the lockfile (layer cached by manifests only) ----
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
# The pnpm version is pinned here and in package.json (packageManager).
RUN corepack enable pnpm && corepack install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core-services/package.json apps/core-services/
COPY apps/notification-worker/package.json apps/notification-worker/
COPY apps/wa-channel/package.json apps/wa-channel/
COPY apps/realtime-gateway/package.json apps/realtime-gateway/
COPY apps/web-staff/package.json apps/web-staff/
COPY packages/db/package.json packages/db/
COPY packages/event-contracts/package.json packages/event-contracts/
COPY packages/messaging/package.json packages/messaging/
COPY packages/shared-types/package.json packages/shared-types/
RUN --mount=type=cache,id=antre-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: compile the services and web-staff, then cut a production-only tree per service ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm --filter @antre/core-services build \
    && pnpm --filter @antre/notification-worker build \
    && pnpm --filter @antre/wa-channel build \
    && pnpm --filter @antre/realtime-gateway build \
    && pnpm --filter @antre/web-staff build
# `pnpm deploy` copies the package plus its production dependencies only (no devDependencies).
RUN for pkg in core-services notification-worker wa-channel realtime-gateway; do \
      pnpm --filter "@antre/${pkg}" deploy --prod --legacy "/out/${pkg}" || exit 1; \
    done \
    && pnpm --filter @antre/db deploy --prod --legacy /out/db

# ---- node-runtime: shared base of the Node services ----
FROM ${NODE_IMAGE} AS node-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY infra/docker/healthcheck.mjs /opt/healthcheck.mjs
# Numeric uid so Kubernetes runAsNonRoot can verify it (uid 1000 is the image's "node" user).
USER 1000:1000

FROM node-runtime AS core-services
ENV CORE_SERVICES_HOST=0.0.0.0 \
    CORE_SERVICES_PORT=3000
COPY --from=build --chown=1000:1000 /out/core-services/package.json ./
COPY --from=build --chown=1000:1000 /out/core-services/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /out/core-services/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/opt/healthcheck.mjs", "3000", "/healthz"]
CMD ["node", "dist/server.js"]

FROM node-runtime AS notification-worker
ENV NOTIFICATION_WORKER_HOST=0.0.0.0 \
    NOTIFICATION_WORKER_PORT=3100
COPY --from=build --chown=1000:1000 /out/notification-worker/package.json ./
COPY --from=build --chown=1000:1000 /out/notification-worker/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /out/notification-worker/dist ./dist
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/opt/healthcheck.mjs", "3100", "/readyz"]
CMD ["node", "dist/server.js"]

FROM node-runtime AS wa-channel
ENV WA_CHANNEL_HOST=0.0.0.0 \
    WA_CHANNEL_PORT=3200
COPY --from=build --chown=1000:1000 /out/wa-channel/package.json ./
COPY --from=build --chown=1000:1000 /out/wa-channel/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /out/wa-channel/dist ./dist
EXPOSE 3200
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/opt/healthcheck.mjs", "3200", "/readyz"]
CMD ["node", "dist/server.js"]

FROM node-runtime AS realtime-gateway
ENV REALTIME_HOST=0.0.0.0 \
    REALTIME_PORT=3300
COPY --from=build --chown=1000:1000 /out/realtime-gateway/package.json ./
COPY --from=build --chown=1000:1000 /out/realtime-gateway/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /out/realtime-gateway/dist ./dist
EXPOSE 3300
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/opt/healthcheck.mjs", "3300", "/readyz"]
CMD ["node", "dist/server.js"]

# ---- db-migrate: one-shot job (compose service / Kubernetes Job), applies packages/db/migrations ----
# Reads DATABASE_MIGRATOR_URL (role antre_migrator). The database roles must already exist (spec 6.1).
FROM node-runtime AS db-migrate
COPY --from=build --chown=1000:1000 /out/db/package.json ./
COPY --from=build --chown=1000:1000 /out/db/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /out/db/migrations ./migrations
ENTRYPOINT ["node", "node_modules/node-pg-migrate/bin/node-pg-migrate.js"]
CMD ["up", "--migrations-dir", "migrations", "--database-url-var", "DATABASE_MIGRATOR_URL", "--no-verbose"]

# ---- web-staff: static files (staff dashboard index.html + Kiosk TV kiosk.html) ----
# nginx-unprivileged: small, runs as uid 101 on port 8080 without extra capabilities, and a static
# file server is all that is needed (routing, TLS, and headers belong to the Traefik gateway).
FROM ${NGINX_IMAGE} AS web-staff
COPY infra/docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web-staff/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
