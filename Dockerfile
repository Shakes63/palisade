# ── Manager image (web + API in one lean container) ─────────────────────────
# Deliberately contains NO game runtime (no Proton/SteamCMD) — game files run in
# separate containers (PLANNING.md → "Keep the manager image lean").
#
# Layered so the big, slow-changing dependency layer (~750 MB) is cached across
# code-only updates: an Unraid "update" then only pulls the ~85 MB of changed
# build artifacts, not the whole image.
# Pinned to the multi-arch index digest so builds are reproducible and the base
# can't be silently swapped upstream. Bump deliberately: check the current digest
# with `docker buildx imagetools inspect node:20-bookworm-slim` and update here.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# openssl + ca-certificates are required by Prisma's query/schema engines (the
# slim image omits them, which otherwise breaks `prisma migrate deploy` on boot).
# sqlite3 is used to take consistent online backups of Conan's live world database;
# unzip extracts uploaded Palworld .pak/framework archives into the instance dir.
# The upgrade keeps Debian security fixes flowing despite the digest-pinned
# base (Trivy blocks the publish on CRITICAL CVEs, so a stale base fails CI).
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates sqlite3 unzip \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# --- deps: install with the lockfile for reproducibility ---
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile || pnpm install

# --- prodmods: PROD-ONLY node_modules + the generated Prisma client, with NO
# app source. A fresh --prod install (not a prune of the deps stage — pnpm
# leaves orphans in .pnpm on reconcile) keeps dev toolchains like vitest/vite/
# esbuild out of the runtime image entirely. Cached unless deps or the Prisma
# schema change, so the runtime's node_modules layer stays byte-identical
# across code-only updates (= not re-pulled). The prisma CLI is a production
# dependency: generate runs here and `migrate deploy` runs at boot.
FROM base AS prodmods
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --prod --frozen-lockfile
COPY apps/api/prisma apps/api/prisma
RUN cd apps/api && pnpm exec prisma generate

# --- build ---
FROM deps AS build
COPY . .
RUN pnpm --filter @ark/api build \
  && pnpm --filter @ark/web build

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
# Fixed for this image: the data dir + DB live at the /data mount, and the
# container clock is UTC (the in-app timezone setting drives scheduling + game
# containers). These don't need to be set in the Unraid template / compose.
ENV DATA_DIR=/data \
    DATABASE_URL=file:/data/db.sqlite \
    TZ=UTC
# 1) Dependencies (big, stable) — from the cached prodmods stage, so code-only
#    updates reuse this layer instead of re-downloading ~750 MB.
COPY --from=prodmods /app/node_modules ./node_modules
# 2) The app: built artifacts (.next/dist), source, manifests, start script.
#    This is the part that changes per update — but it's only ~85 MB.
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/docker ./docker
EXPOSE 3000 8787
# Strip any Windows CR from the start script — a CRLF-encoded file makes bash
# see `pipefail\r` as the option name and fail immediately at startup.
RUN sed -i 's/\r//' docker/start.sh
# gosu + tini would be added here for PUID/PGID drop + signal handling.
CMD ["bash", "docker/start.sh"]
