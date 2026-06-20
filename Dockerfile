# ── Manager image (web + API in one lean container) ─────────────────────────
# Deliberately contains NO game runtime (no Proton/SteamCMD) — game files run in
# separate containers (PLANNING.md → "Keep the manager image lean").
#
# Layered so the big, slow-changing dependency layer (~750 MB) is cached across
# code-only updates: an Unraid "update" then only pulls the ~85 MB of changed
# build artifacts, not the whole image.
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# openssl + ca-certificates are required by Prisma's query/schema engines (the
# slim image omits them, which otherwise breaks `prisma migrate deploy` on boot).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
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

# --- prodmods: node_modules + the generated Prisma client, with NO app source.
# Cached unless deps or the Prisma schema change, so the runtime's node_modules
# layer stays byte-identical across code-only updates (= not re-pulled).
FROM deps AS prodmods
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
# gosu + tini would be added here for PUID/PGID drop + signal handling.
CMD ["bash", "docker/start.sh"]
