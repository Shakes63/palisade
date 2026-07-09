# <img src="unraid/palisade-icon.png" width="40" alt="" align="top"> Palisade

> Formerly **ARK Server Manager** — it outgrew the name. Old repo links redirect.
>
> **Now on Unraid Community Applications** — search "Palisade" in the Apps tab.

A self-hosted, Docker-based control panel for game dedicated servers — built
Unraid-first, but it runs on any Linux box with Docker. One lean manager
container spawns and supervises a container per game server, manages every
setting through schema-driven forms, and handles mods, backups, schedules,
player administration, and even your router's port-forwards.

**Supported games (10):**

| Game | Runtime | Console | Mods |
|---|---|---|---|
| ARK: Survival Ascended | Proton (POK image) | RCON | CurseForge browser |
| ARK: Survival Evolved | native | RCON | Steam Workshop browser |
| Conan Exiles | native | RCON | Steam Workshop browser |
| Palworld | native | RCON | UE4SS/pak uploader |
| Minecraft (Java) | native (itzg) | RCON | CurseForge modpacks (auto-install) |
| Minecraft Bedrock | native (itzg) | — | add-on pack uploader |
| Icarus | Wine | — | .pak uploader |
| Valheim | native (lloesche) | — | Thunderstore browser (auto-deps) |
| 7 Days to Die | native (LinuxGSM) | telnet (in-app) | mod-zip uploader |
| Enshrouded | Proton | — | — (game has no mod support) |

**Feature highlights**

- Create → install → start with per-game readiness detection, graceful
  shutdown, a crash watchdog, and a RAM guard that offers to back up + swap
  servers when memory is tight.
- Full per-game settings catalogs with presets, copy-between-servers, and
  restart-needed tracking.
- Live player counts for every game (A2S / RakNet ping / RCON / Valheim status
  endpoint) with 1-hour sparklines, plus a **Players** roster captured from
  player lists and join logs — kick / ban / whitelist / admin per game.
- Backups: manual + scheduled with retention, restore, browser download, and
  saves import. The manager also snapshots its own database nightly.
- Schedules (restart / update / backup / stop / start) with in-game countdown
  warnings, pre-action snapshots, and a "skip while players are online" guard.
- ARK cluster support (shared transfer dir across servers).
- Discord/webhook notifications, host low-disk warnings, editable ports with a
  start-time port-conflict guard.
- Optional **pfSense integration**: one-click WAN port-forward
  create/fix/enable/disable/delete per server via the pfSense REST API.

See [PLANNING.md](PLANNING.md) for architecture details.

## Architecture at a glance

```
palisade (this app) ────/var/run/docker.sock──> Docker daemon
   Next.js UI + NestJS API                       │ spawns
   SQLite · config engine · RCON · scheduler     ▼
                                       one container per game server
```

The manager is a **control plane only** — it contains no game runtime. Each
game server runs in its own container from a proven community image; the
manager injects config, watches logs, and talks RCON/telnet/query protocols.

---

## Installation

### Prerequisites

- Docker on a Linux host (Unraid, Debian/Ubuntu, etc.). 16 GB+ RAM recommended —
  a single populated game server wants 2–16 GB depending on the game.
- A Docker bridge network for the manager (game containers join it too unless
  you use host networking):

  ```bash
  docker network create ark-net
  ```

- Two secrets (generate once, keep safe — `SECRETS_KEY` encrypts stored API
  keys/passwords, so losing it means re-entering them):

  ```bash
  echo "SECRETS_KEY=$(openssl rand -hex 32)"
  echo "JWT_SECRET=$(openssl rand -hex 32)"
  ```

- For the Wine/Proton games (Icarus, Enshrouded), the **host** needs a larger
  mmap limit or the server crashes on boot:

  ```bash
  sysctl -w vm.max_map_count=262144
  # persist it: /etc/sysctl.conf, or on Unraid append to /boot/config/go
  ```

### Option A — Unraid (Community Applications) ⭐ recommended

Palisade is in [Community Applications](https://ca.unraid.net): open the
**Apps** tab, search for **Palisade**, and install. The template pre-fills
everything except your two secrets (`SECRETS_KEY`, `JWT_SECRET` — generators
above) and the app-data path. The prerequisites above still apply: create the
`ark-net` network and set the `vm.max_map_count` sysctl once.

Two Unraid-specific notes baked into the template:
- Use a path on the cache disk itself (`/mnt/cache/appdata/...`), **not**
  `/mnt/user/...` — the ARK game-file cache reflink-clones between servers,
  which needs one real filesystem.
- Spawned game servers appear on the Docker page with per-game icons and WebUI
  buttons that deep-link back into Palisade.

(Manual alternative: drop [unraid/palisade.xml](unraid/palisade.xml) into
`/boot/config/plugins/dockerMan/templates-user/`.)

### Option B — plain `docker run`

```bash
docker run -d \
  --name palisade \
  --network ark-net \
  --restart unless-stopped \
  -p 8970:3000 \
  -v /opt/palisade:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  -e NODE_ENV=production \
  -e DATA_DIR=/data \
  -e DATABASE_URL=file:/data/db.sqlite \
  -e HOST_DATA_DIR=/opt/palisade \
  -e PUBLIC_BASE_URL=http://YOUR-LAN-IP:8970 \
  -e SECRETS_KEY=<64 hex chars> \
  -e JWT_SECRET=<random string> \
  -e PUID=99 -e PGID=100 \
  -e TZ=America/Chicago \
  -e GAME_HOST_NETWORK=true \
  ghcr.io/shakes63/palisade:latest
```

Then open `http://YOUR-LAN-IP:8970` and complete the first-run wizard
(create the admin account; API keys are optional and can be added later in
Settings).

### Option C — docker compose

A reference [`docker-compose.yml`](docker-compose.yml) ships in the repo:

```bash
export SECRETS_KEY=... JWT_SECRET=... HOST_DATA_DIR=/opt/palisade
docker compose up -d
```

### Environment variables

| Variable | Required | Default | What |
|---|---|---|---|
| `SECRETS_KEY` | **yes** | — | 64 hex chars (32 bytes). Encrypts stored secrets at rest. |
| `JWT_SECRET` | **yes** | — | Signs login tokens (sessions last 30 days). |
| `HOST_DATA_DIR` | **yes**¹ | `DATA_DIR` | The data dir **as the host's Docker daemon sees it** (e.g. `/mnt/user/appdata/ark-manager` on Unraid). Game-container bind mounts resolve on the host, not inside the manager. |
| `DATA_DIR` | no | `./data` | Data dir inside the manager container (mount your volume here, conventionally `/data`). |
| `DATABASE_URL` | no | `file:./data/db.sqlite` | SQLite path — keep it inside `DATA_DIR`. |
| `PUBLIC_BASE_URL` | no | `http://localhost:3000` | The address you actually browse to. Used for links and Unraid WebUI buttons. |
| `GAME_HOST_NETWORK` | no | `false` | `true` = game containers use host networking (recommended — ASA/EOS and Steam query behave better without Docker NAT). Requires the `--add-host host.docker.internal:host-gateway` flag on the manager so it can still reach RCON/query. |
| `DOCKER_HOST` | no | unix socket | Point at `tcp://socket-proxy:2375` for least-privilege Docker access ([docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)). |
| `PUID` / `PGID` | no | `99` / `100` | Ownership for game files written by the manager (Unraid's `nobody:users` by default). |
| `TZ` | no | `UTC` | Manager clock; also the default for game containers and schedules (overridable in Settings). |

¹ Required whenever the container path and host path differ — i.e. basically
always in production.

### Data layout

Everything lives under your data dir — one directory to back up:

```
/data
├── db.sqlite            # server definitions, schedules, players, settings
├── instances/<id>/      # each server's game files + world saves
├── backups/<id>/        # world snapshots (retention-rotated)
├── backups/_manager/    # nightly self-backups of db.sqlite (newest 14)
└── clusters/<id>/       # ARK cluster transfer dirs
```

Deleting a server from the UI asks whether to wipe its instance + backups, and
offers a browser download of the world saves first.

### Updating

The image is rebuilt on every push to `main`
(GitHub Actions → `ghcr.io/shakes63/palisade:latest`). To update:
pull the new image and recreate the container (Unraid's update button does
both). Database migrations run automatically on boot.

---

## Integrations (all optional, all in Settings)

| Integration | What it enables | What you need |
|---|---|---|
| CurseForge API key | ASA mod browser, Minecraft modpack browser | Free key from <https://console.curseforge.com/> |
| Steam Web API key | ASE/Conan Workshop browser | Free key from <https://steamcommunity.com/dev/apikey> |
| Discord webhook | State changes, crashes, backups, schedule events | A channel webhook URL |
| pfSense | Per-server WAN port-forward management (create / fix / enable / disable / delete, WAN IP display) | The free [pfSense REST API package](https://pfrest.org/) on your router + an API key (System → REST API). Works with any pfSense — nothing is network-specific. Use the **Test connection** button to validate. |

**CurseForge terms:** the mod browser uses the CurseForge API read-only to
search and display mods; it never downloads or redistributes mod files — the
game servers fetch mods themselves through official integrations. Bring your
own key; keys are non-transferable under CurseForge's
[3rd-party API terms](https://support.curseforge.com/en/support/solutions/articles/9000207405-curse-forge-3rd-party-api-terms-and-conditions).
This repo does not ship one.

## Reverse proxy / TLS

The app is LAN-first but proxy-friendly:

- Front it with Nginx Proxy Manager / Traefik / Caddy with TLS; proxy `/`,
  `/api`, and `/socket.io` to the web port (container port 3000) — the web app
  forwards API + websocket traffic internally.
- Set `PUBLIC_BASE_URL` to the external origin.
- The manager controls Docker via the host socket. If you expose the UI beyond
  your LAN, strongly consider the socket-proxy setup above.

## Development

```bash
pnpm install

# generate secrets, then copy .env.example → .env
node -e "console.log('SECRETS_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('JWT_SECRET='  + require('crypto').randomBytes(32).toString('hex'))"

pnpm --filter @ark/api db:push   # create the dev SQLite db
pnpm dev                         # API on :8787 + web on :3000
pnpm --filter @ark/api test      # unit tests
```

Monorepo layout: `packages/shared` (types + settings catalogs contract),
`apps/api` (NestJS orchestrator), `apps/web` (Next.js UI), `docker/` (manager
entrypoint), `unraid/` (CA template).

## Acknowledgements

Palisade is a control plane — the actual game servers run on excellent
community-maintained images. Huge thanks to their maintainers; this project
wouldn't exist without them:

| Game(s) | Image | Maintainer / project |
|---|---|---|
| ARK: Survival Ascended | `acekorneya/asa_server` | [Acekorneya (POK)](https://github.com/Acekorneya/Ark-Survival-Ascended-Server) |
| Conan Exiles | `acekorneya/conan_enhanced_server` | [Acekorneya (POK)](https://github.com/Acekorneya/POK_Conan_Enhanced_Docker_server) |
| ARK: Survival Evolved | `hermsi/ark-server` | [Hermsi1337](https://github.com/Hermsi1337/docker-ark-server) |
| Palworld | `thijsvanloef/palworld-server-docker` | [Thijs van Loef](https://github.com/thijsvanloef/palworld-server-docker) |
| Minecraft (Java) | `itzg/minecraft-server` | [itzg (Geoff Bourne)](https://github.com/itzg/docker-minecraft-server) |
| Minecraft Bedrock | `itzg/minecraft-bedrock-server` | [itzg (Geoff Bourne)](https://github.com/itzg/docker-minecraft-bedrock-server) |
| Icarus | `mornedhels/icarus-server` | [mornedhels](https://github.com/mornedhels/icarus-server) |
| Enshrouded | `mornedhels/enshrouded-server` | [mornedhels](https://github.com/mornedhels/enshrouded-server) |
| Valheim | `lloesche/valheim-server` | [lloesche / community-valheim-tools](https://github.com/community-valheim-tools/valheim-server-docker) |
| 7 Days to Die | `vinanrra/7dtd-server` | [vinanrra](https://github.com/vinanrra/Docker-7DaysToDie) (built on [LinuxGSM](https://linuxgsm.com/)) |

Also standing on: [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD),
GE-Proton/Wine for the Windows-only servers,
[Thunderstore](https://thunderstore.io/) (Valheim mod index), and the
[CurseForge](https://www.curseforge.com/) + Steam Web APIs for mod browsing.

## License

[MIT](LICENSE) © 2026 Jacob Neudorf. Not affiliated with Studio Wildcard,
Overwolf/CurseForge, Valve, Iron Gate, The Fun Pimps, Keen Games, RocketWerkz,
Funcom, Pocketpair, Mojang, or Netgate.
