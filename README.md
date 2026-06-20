# ARK Server Manager

A self-hosted, Docker-based control panel for **ARK: Survival Ascended (ASA)** and
**ARK: Survival Evolved (ASE)** dedicated servers — built Unraid-first. It installs
servers via SteamCMD, manages every setting, handles mods + clusters, and gives you
a live RCON console and scheduled tasks.

See [PLANNING.md](PLANNING.md) for the full architecture and roadmap.

## Architecture at a glance

```
ark-manager (this app) ──/var/run/docker.sock──> Docker daemon
   Next.js UI + NestJS API                       │ spawns
   SQLite · config engine · RCON · scheduler     ▼
                                       one container per ARK server
```

- The manager is a **lean control plane** — it contains no game runtime. Each ARK
  server runs in its **own container** spawned from a base image.
- Game files install **once per game** into a shared volume via an **ephemeral
  SteamCMD installer container**.
- Docker is controlled via the host's **Docker socket** mounted into the manager.
  For least-privilege access you can instead front it with a
  [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) and point
  `DOCKER_HOST` at it. Secrets (API keys, admin password) are **encrypted at rest**.

## Monorepo layout

| Path | What |
|---|---|
| `packages/shared` | Types shared by API + web (game ids, state machine, settings-catalog, DTOs) |
| `apps/api` | NestJS backend — orchestrator, config engine, RCON, installer, scheduler |
| `apps/web` | Next.js frontend — dashboard, schema-driven settings, RCON console, schedules |
| `docker/` | Manager start script + ASA/ASE game-server image Dockerfiles |
| `unraid/` | Community Applications template |

## Development

```bash
pnpm install

# generate a SECRETS_KEY + JWT_SECRET, then copy .env.example → .env
node -e "console.log('SECRETS_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('JWT_SECRET='  + require('crypto').randomBytes(32).toString('hex'))"

# backend: generate the Prisma client + create the SQLite db
pnpm --filter @ark/api db:push

# run API (:8787) and web (:3000) together
pnpm dev
```

Run the config-engine unit tests:

```bash
pnpm --filter @ark/api test
```

## Deployment (Unraid)

1. Install the manager via the [Unraid template](unraid/ark-manager.xml) (or
   `docker-compose.yml`); mount `/var/run/docker.sock` and set `HOST_DATA_DIR`,
   `SECRETS_KEY`, and `JWT_SECRET`. For least-privilege Docker access, front the
   socket with a `tecnativa/docker-socket-proxy` and set `DOCKER_HOST` to it.
2. Open the Web UI and complete the first-run wizard.

> Game-server images (`docker/asa-server`, `docker/ase-server`) are built FROM a
> proven community base (GE-Proton + SteamCMD). The exact base tag and Proton
> invocation are finalized during Phase 1 testing against a real host.

## Mods & the CurseForge API

For **ARK: Survival Ascended**, the mod browser uses the CurseForge API **read-only** —
only `GET /v1/mods/search` and `GET /v1/mods/{id}` to show a mod's name, author,
description and thumbnail so you can pick mods for a server. **It never downloads or
redistributes mod files** — the ARK dedicated server downloads mods itself, by mod ID,
through CurseForge's official game integration. (ASE mods come from the Steam Workshop.)

**Bring your own API key.** To use the ASA mod browser, supply **your own** CurseForge API
key in the app's Settings (stored server-side, encrypted at rest) — apply for one at
<https://console.curseforge.com/>. CurseForge API keys are non-transferable under their
[3rd-party API terms](https://support.curseforge.com/en/support/solutions/articles/9000207405-curse-forge-3rd-party-api-terms-and-conditions);
never share, embed, or commit them. This repo does not ship a key.

## Reverse proxy / TLS

The app is LAN-first but proxy-friendly. To expose it safely:

- Put it behind Nginx Proxy Manager / Traefik with TLS; proxy `/`, `/api`, and
  `/socket.io` to the web container (port 3000), which forwards `/api` + websockets
  to the API.
- Set `PUBLIC_BASE_URL` to the external origin.
- Keep `SECRETS_KEY` / `JWT_SECRET` strong and private; secrets are encrypted at
  rest. The manager controls Docker via the host socket — if you expose it beyond
  your LAN, consider fronting Docker with a least-privilege socket-proxy.

## Status

All roadmap phases are implemented and verified (unit tests + live API exercise;
Docker-runtime steps are validated against a real host):

- **Phase 0** — monorepo scaffold, auth, encrypted secrets, socket-proxy, first-run wizard
- **Phase 1** — ASA vertical slice: install → schema-driven config → create/start/stop with
  the manager↔container contract (log-parse readiness, graceful shutdown, crash watchdog) →
  live RCON → scheduler with pre-action snapshots
- **Phase 2** — mods + CurseForge browser (load order, version pin, install-by-id)
- **Phase 3** — clusters (shared transfer dir, members, coordinated start/stop)
- **Phase 4** — ASE support (native runtime, Steam Workshop browser, game-aware mod routing)
- **Phase 5** — backups (retention/restore), instance import, Discord/webhook notifications,
  users/RBAC foundation, reverse-proxy hardening

See [PLANNING.md](PLANNING.md) for the architecture and the deferred follow-ups.

## License

[MIT](LICENSE) © 2026 Jacob Neudorf. Not affiliated with Studio Wildcard, Overwolf, or CurseForge.
