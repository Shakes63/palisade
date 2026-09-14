#!/usr/bin/env bash
# Launch the API and the web app together in the single manager container.
set -euo pipefail

echo "[palisade] applying database migrations..."
# Fatal on failure: starting the API against an unmigrated DB just crashes later
# with confusing "no such table" errors. set -e aborts the container so Docker
# restarts it and the migration error is surfaced in the logs.
( cd apps/api && pnpm prisma migrate deploy )

echo "[palisade] starting API on :${API_PORT:-8787} and web on :${WEB_PORT:-3000}"
# tsc emits with the monorepo dir structure preserved under dist/.
( cd apps/api && node dist/apps/api/src/main.js ) &
API_PID=$!
( cd apps/web && pnpm start -p "${WEB_PORT:-3000}" ) &
WEB_PID=$!

# Forward shutdown signals to the children: bash gets Docker's SIGTERM (it is
# PID 1's process group leader) but does NOT propagate it — without this trap
# node never sees the signal, Nest's shutdown hooks (last-second world saves)
# never run, and Docker SIGKILLs everything at the end of the grace period.
term() {
  kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap term TERM INT

# If either process dies, take the whole container down so Docker restarts it.
# The `|| CODE=$?` is load-bearing: a trapped SIGTERM makes `wait -n` return
# >128, and under `set -e` that would abort the script RIGHT HERE — bash (PID 1)
# exits, Docker declares the container dead and SIGKILLs node before the
# graceful shutdown (world saves!) gets a single millisecond.
CODE=0
wait -n "$API_PID" "$WEB_PID" || CODE=$?
# One side exited (or we were signalled) — bring the sibling down and reap both
# so the API's graceful shutdown fully completes before the container dies.
term
wait "$API_PID" "$WEB_PID" 2>/dev/null || true
exit $CODE
