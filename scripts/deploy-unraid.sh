#!/bin/bash
# Redeploy Palisade on an Unraid box over SSH — pull an image tag and recreate
# the container with the SAME config it already has.
#
# Usage: scripts/deploy-unraid.sh [ssh-host] [tag] [container-name]
#   scripts/deploy-unraid.sh tower           # track the stable channel
#   scripts/deploy-unraid.sh tower nightly   # ride the bleeding-edge channel
#   scripts/deploy-unraid.sh tower nightly Palisade-test   # a second instance
#
# The container name + data dir are unchanged regardless of tag, so this just
# swaps which code runs on the SAME data. Heads-up when moving to nightly: it
# may apply DB migrations that a later rollback to a stable release can't undo
# (Prisma only migrates forward). The manager self-backs-up its DB nightly, but
# take a fresh backup first if you care.
#
# "Same config" means what the running container actually has, read back from
# `docker inspect`: env, mounts, published ports, networks, Unraid labels,
# restart policy, stop timeout, and how it reaches Docker. This script used to
# hard-code those instead, so every deploy quietly rewrote them — it moved the
# manager onto "ark-net" (the pre-1.11 name, which makes Unraid's WebUI button
# point at the bridge IP on macvlan hosts, GH #31) and switched installs onto
# the socket proxy behind the user's back, where a proxy that denies NETWORKS
# then 403s every network call. A deploy changes the image. Nothing else.
#
# Secrets never touch disk: the current container's env is piped straight into
# `docker run --env-file /dev/stdin` (no /tmp file to leak on a crash).
#
# First install only (no container by that name yet), it falls back to the
# documented defaults: port 8970, /mnt/cache/appdata/ark-manager, the shared
# network, and the docker-socket proxy when one is running.
set -euo pipefail

HOST="${1:-tower}"
TAG="${2:-latest}"
NAME="${3:-Palisade}"
IMAGE="ghcr.io/shakes63/palisade:${TAG}"

if [ "$TAG" != "latest" ]; then
  echo "WARNING: deploying the '${TAG}' channel to '${NAME}' on ${HOST} (same data dir)."
  echo "         A rollback to an older stable release may hit un-downgradable DB migrations."
fi

# Args, not interpolation: the remote script is quoted, so nothing here is
# expanded locally and remote $vars need no escaping.
ssh "$HOST" bash -s -- "$IMAGE" "$NAME" <<'REMOTE'
set -euo pipefail
IMAGE="$1"
NAME="$2"

# Defaults for a first install; every one of them is overridden below by what an
# existing container already has.
PROXY_NAME="palisade-docker-proxy"
PROXY_NET="palisade-proxy"
DEF_PORT="8970"
DEF_DATA="/mnt/cache/appdata/ark-manager"
DEF_NET="palisade-net" # DEFAULT_SHARED_NETWORK in apps/api/src/common/naming.ts

docker pull "$IMAGE" >/dev/null
echo "pulled $(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}')"

inspect() { docker inspect "$NAME" --format "$1"; }

ARGS=( --name "$NAME" )
NETWORKS=()

if docker inspect "$NAME" >/dev/null 2>&1; then
  echo "recreating ${NAME} with its current config"

  # Env, minus DOCKER_HOST — re-added below so it stays paired with the mount
  # (or the proxy network) that makes it reachable.
  ENV_CONTENT=$(inspect '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^DOCKER_HOST=' || true)
  DOCKER_HOST_ENV=$(inspect '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^DOCKER_HOST=//p' | head -1)

  while IFS= read -r bind; do
    [ -n "$bind" ] && ARGS+=( -v "$bind" )
  done < <(inspect '{{range .HostConfig.Binds}}{{println .}}{{end}}')

  # HostPort|ContainerPort/proto, one line per published port.
  while IFS='|' read -r hostport cport; do
    [ -n "$cport" ] && ARGS+=( -p "${hostport}:${cport}" )
  done < <(inspect '{{range $p, $cfg := .HostConfig.PortBindings}}{{range $cfg}}{{.HostPort}}|{{$p}}{{println}}{{end}}{{end}}')

  while IFS= read -r host; do
    [ -n "$host" ] && ARGS+=( --add-host "$host" )
  done < <(inspect '{{range .HostConfig.ExtraHosts}}{{println .}}{{end}}')

  # Unraid's own labels only: the rest of .Config.Labels comes from the image
  # and would be re-applied by it anyway.
  while IFS= read -r label; do
    [ -n "$label" ] && ARGS+=( -l "$label" )
  done < <(inspect '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' | grep '^net\.unraid\.' || true)

  RESTART=$(inspect '{{.HostConfig.RestartPolicy.Name}}')
  [ -n "$RESTART" ] && [ "$RESTART" != "no" ] && ARGS+=( --restart "$RESTART" )
  STOP_TIMEOUT=$(inspect '{{if .Config.StopTimeout}}{{.Config.StopTimeout}}{{end}}')
  [ -n "$STOP_TIMEOUT" ] && ARGS+=( --stop-timeout "$STOP_TIMEOUT" )

  # The primary network becomes --network; the rest are reattached after create,
  # in the order the daemon reports them.
  PRIMARY=$(inspect '{{.HostConfig.NetworkMode}}')
  while IFS= read -r net; do
    [ -n "$net" ] && [ "$net" != "$PRIMARY" ] && NETWORKS+=( "$net" )
  done < <(inspect '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}')
  [ -n "$PRIMARY" ] && ARGS+=( --network "$PRIMARY" )

  # Whatever it was already using to reach Docker. The socket mount, if it has
  # one, came across with the binds above.
  ARGS+=( -e "DOCKER_HOST=${DOCKER_HOST_ENV:-unix:///var/run/docker.sock}" )

  docker stop "$NAME" >/dev/null
  docker rm "$NAME" >/dev/null
else
  echo "no ${NAME} container yet — creating one with the default layout"
  ENV_CONTENT=""
  ARGS+=(
    --network "$DEF_NET"
    -p "${DEF_PORT}:3000"
    --add-host host.docker.internal:host-gateway
    -v "${DEF_DATA}:/data:rw"
    -l net.unraid.docker.icon=https://raw.githubusercontent.com/Shakes63/palisade/main/unraid/palisade-icon.png
    -l net.unraid.docker.managed=dockerman
    -l 'net.unraid.docker.webui=http://[IP]:[PORT:3000]/'
    --restart unless-stopped
    --stop-timeout 30
  )
  docker network inspect "$DEF_NET" >/dev/null 2>&1 || docker network create "$DEF_NET" >/dev/null
  # Least-privilege Docker access when a proxy is already running; otherwise the
  # classic socket mount.
  if docker inspect "$PROXY_NAME" >/dev/null 2>&1; then
    ARGS+=( -e "DOCKER_HOST=tcp://${PROXY_NAME}:2375" )
    NETWORKS+=( "$PROXY_NET" )
  else
    ARGS+=( -e DOCKER_HOST=unix:///var/run/docker.sock -v /var/run/docker.sock:/var/run/docker.sock:rw )
  fi
fi

ARGS+=( --env-file /dev/stdin )

# create → attach the remaining networks → start, so DOCKER_HOST is reachable
# the moment the API boots.
printf '%s\n' "$ENV_CONTENT" | docker create "${ARGS[@]}" "$IMAGE" >/dev/null
for net in ${NETWORKS[@]+"${NETWORKS[@]}"}; do
  docker network connect "$net" "$NAME"
done
docker start "$NAME" >/dev/null

echo "networks: $(docker inspect "$NAME" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
sleep 8
docker logs "$NAME" 2>&1 | grep -m1 listening
REMOTE
