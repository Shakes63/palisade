#!/usr/bin/env bash
# Launch the API and the web app together in the single manager container.
set -euo pipefail

echo "[ark-manager] applying database migrations..."
# Fatal on failure: starting the API against an unmigrated DB just crashes later
# with confusing "no such table" errors. set -e aborts the container so Docker
# restarts it and the migration error is surfaced in the logs.
( cd apps/api && pnpm prisma migrate deploy )

echo "[ark-manager] starting API on :${API_PORT:-8787} and web on :${WEB_PORT:-3000}"
# tsc emits with the monorepo dir structure preserved under dist/.
( cd apps/api && node dist/apps/api/src/main.js ) &
API_PID=$!
( cd apps/web && pnpm start -p "${WEB_PORT:-3000}" ) &
WEB_PID=$!

# If either process dies, take the whole container down so Docker restarts it.
wait -n "$API_PID" "$WEB_PID"
exit $?
