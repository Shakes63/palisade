# <img src="unraid/palisade-icon.png" width="40" alt="" align="top"> Palisade

> Formerly **ARK Server Manager** — it outgrew the name. Old repo links redirect.
>
> **Now on Unraid Community Applications** — search "Palisade" in the Apps tab.

A self-hosted, Docker-based control panel for game dedicated servers — built
Unraid-first, but it runs on any Linux box with Docker. One lean manager
container spawns and supervises a container per game server, manages every
setting through schema-driven forms, and handles mods, backups, schedules,
player administration, and even your router's port-forwards.

## Quick start (Unraid)

1. **Apps tab → search "Palisade" → Install.** The defaults are ready to go — the
   only field to check is **App data**: point it at a folder on a real disk
   (`/mnt/cache/appdata/palisade`), *not* the `/mnt/user` FUSE share, so the game-file
   cache can reflink-clone between servers.
2. **Leave the secrets and `HOST_DATA_DIR` blank.** The manager generates and persists
   its own keys on first start and auto-detects the host data path — there's nothing to
   generate in a terminal.
3. **Open the WebUI**, create your admin account on the first-run screen, and add a game
   server. That's it.

> Not on Unraid? It's a single container — run the same image (`ghcr.io/shakes63/palisade`)
> with `/var/run/docker.sock` and a data volume mounted; see the template in
> [`unraid/palisade.xml`](unraid/palisade.xml) for the full env/mount list.

**Supported games (26)** — each has a [per-game guide](docs/games/README.md) covering ports, joining, first boot, and gotchas:

| Game | Runtime | Console | Mods |
|---|---|---|---|
| ARK: Survival Ascended | Proton (POK image) | RCON | CurseForge browser |
| ARK: Survival Evolved | native | RCON | Steam Workshop browser |
| Conan Exiles | native | RCON | Steam Workshop browser |
| Palworld | native | RCON | UE4SS (Linux)/pak uploader [^pal] |
| Palworld (Wine — full mods) | Wine (ripps818) | RCON | UE4SS (Windows) + DLL mods/pak uploader [^palwine] |
| Minecraft (Java) | native (itzg) | RCON | CurseForge modpacks (auto-install) |
| Minecraft Bedrock | native (itzg) | — | add-on pack uploader |
| Icarus | Wine | — | .pak uploader |
| Valheim | native (lloesche) | — | Thunderstore browser (auto-deps) |
| 7 Days to Die | native (LinuxGSM) | telnet (in-app) | mod-zip uploader |
| Enshrouded | Proton | — | — (game has no mod support) |
| Project Zomboid | native (Java) | RCON | Steam Workshop browser (auto Mod-ID) |
| V Rising | Wine | RCON (announce) | — (game has no official mod support) |
| Sons of the Forest | Wine | — | — (game has no official mod support) |
| Satisfactory | native | — (HTTPS API: auto-claim) | — (SFTP per upstream docs) |
| Life is Feudal: Your Own | Wine (+ bundled MariaDB) | — (in-game GM password) | — (file-based per upstream docs) |
| American Truck Simulator | native | — | — (optional mods via session host) |
| Euro Truck Simulator 2 | native | — | — (optional mods via session host) |
| Core Keeper | native | — | — (no ports needed: Steam-relay Game ID joins) |
| Terraria (TShock) | native | — (REST-powered counts) | plugin folder (TShock ServerPlugins) |
| Factorio | native | RCON | mods folder (+ mod-portal auto-update) |
| Rust | native | RCON | Oxide/uMod toggle (plugins folder) |
| BeamNG.drive (BeamMP) | native | — | client-mod + Lua plugin folders |
| OpenTTD | native (ich777) | in-game console | — (NewGRFs via in-game content) |
| Counter-Strike 2 | native (joedwards32) | RCON | Workshop maps/collections (by ID) |
| Don't Starve Together | native (jamesits) | — (in-game console) | — (Workshop mods via cluster files) |

[^pal]: Palworld runs the **native Linux** server, so mods are `.pak` content mods plus
    Lua/Blueprint mods loaded by UE4SS. Official UE4SS releases are Windows-only — there is no
    `libUE4SS.so` there. Use the experimental
    [native Linux build](https://github.com/Yangff/RE-UE4SS/releases/tag/linux-experiment)
    (`UE4SS_0.0.0.zip`) and upload it in the server's Mods tab. DLL-based mods (PalGuard,
    PalDefender) cannot load into a Linux process; those require running the Windows server
    under Wine, which this image does not do.

[^palwine]: The **Palworld (Wine — full mods)** variant runs the **Windows** server under Wine,
    so DLL-based mods (PalGuard, PalDefender) load alongside Lua/Blueprint and `.pak` mods. The
    Mods tab installs the official
    [UE4SS Windows build](https://github.com/UE4SS-RE/RE-UE4SS/releases/tag/v3.0.1) into
    `Pal/Binaries/Win64`, where Wine auto-loads it via the `dwmapi.dll` proxy — no LD_PRELOAD.
    Heavier and crashier than the native variant; pick it only when you need DLL mods.

**Feature highlights**

- Create → install → start with per-game readiness detection, graceful
  shutdown, a crash watchdog, and a RAM guard that offers to back up + swap
  servers when memory is tight.
- Full per-game settings catalogs with presets, copy-between-servers, and
  restart-needed tracking.
- Live player counts for every game (A2S / RakNet ping / RCON / Valheim status
  endpoint) with 1-hour sparklines, plus a **Players** roster captured from
  player lists and join logs — kick / ban / whitelist / admin per game.
- Backups: manual + scheduled with restore, browser download, and saves import.
  **Retention is set per server** (on its Backups tab; default 10, up to 500) and
  rotates only the **automatic** snapshots — scheduled ones and the safety copies
  taken before an update, restart or restore. Backups you take yourself are kept
  until you delete them, on the replication target too. The manager also snapshots
  its own database nightly, with its own retention in Settings → Backups.
- Schedules (restart / update / backup / stop / start) with in-game countdown
  warnings, pre-action snapshots, and a "skip while players are online" guard.
- **Version pinning** from registry-populated dropdowns: pin the **game version /
  Steam branch** where the server image supports it (Minecraft, OpenTTD, 7DTD,
  Enshrouded, Valheim, Palworld, V Rising, Satisfactory, ATS/ETS2, LiF:YO), and —
  for advanced rollbacks — pin the **Docker image tag** on any game, with a
  per-game note explaining exactly what each pin does and doesn't control.
- A crashed server shows **why** it died (exit code / OOM + a log tail) right on
  its Overview, instead of a bare "Crashed" badge.
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
- A Docker bridge network, `palisade-net` — the manager and the game containers it
  spawns share it (unless you use host networking). **Palisade creates it on
  demand and attaches itself to it**, so there is normally nothing to do — including
  when the manager runs on an Unraid custom/macvlan network, where it keeps its own
  IP and simply gains a route to the game containers. Do it yourself only if you set
  `AUTO_CREATE_NETWORK=false`, or if Docker access is locked down (a socket-proxy
  with `NETWORKS=0` can neither create networks nor attach to them):

  ```bash
  docker network create palisade-net
  docker network connect palisade-net <your Palisade container>
  ```

  Installs from before v1.11 use `ark-net`. Nothing to do: each server moves across
  the next time you start it, and Palisade holds both networks until they all have.
  See [Moving off `ark-net`](#moving-off-ark-net).

- Two secrets (generate once, keep safe — `SECRETS_KEY` encrypts stored API
  keys/passwords, so losing it means re-entering them):

  ```bash
  echo "SECRETS_KEY=$(openssl rand -hex 32)"
  echo "JWT_SECRET=$(openssl rand -hex 32)"
  ```

- For the Wine/Proton games (Icarus, Enshrouded, V Rising, Sons of the Forest, LiF:YO), the **host** needs a larger
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
`palisade-net` network and set the `vm.max_map_count` sysctl once.

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
  --network palisade-net \
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
| `HOST_DATA_DIR` ⚙ | no¹ | auto-detected | The data dir **as the host's Docker daemon sees it** (e.g. `/mnt/cache/appdata/palisade` on Unraid). Game-container bind mounts resolve on the host, not inside the manager. Leave it unset: the manager reads it off its own `/data` mount at boot. |
| `DATA_DIR` | no | `./data` | Data dir inside the manager container (mount your volume here, conventionally `/data`). |
| `DATABASE_URL` | no | `file:./data/db.sqlite` | SQLite path — keep it inside `DATA_DIR`. |
| `PUBLIC_BASE_URL` ⚙ | no | `http://localhost:3000` | The address you actually browse to. Used for links and Unraid WebUI buttons. |
| `GAME_HOST_NETWORK` ⚙ | no | `false` | `true` = game containers use host networking (recommended — ASA/EOS and Steam query behave better without Docker NAT). Requires the `--add-host host.docker.internal:host-gateway` flag on the manager so it can still reach RCON/query. Individual servers can override this on their own General card. |
| `AUTO_CREATE_NETWORK` ⚙ | no | `true` | Let Palisade manage its bridge: create it when a game server needs it, attach itself to it when it isn't already (added live — existing networks and a static IP are kept), and drop the legacy `ark-net` once nothing uses it. Set `false` to manage Docker networks yourself. |
| `SHARED_NETWORK` | no | `palisade-net` | Name of that bridge. The default is chosen so Unraid resolves the manager's WebUI link correctly on a custom network (see [Moving off `ark-net`](#moving-off-ark-net)); change it only if you manage the network yourself. |
| `DOCKER_HOST` | no | unix socket | Point at `tcp://socket-proxy:2375` for least-privilege Docker access ([docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)). |
| `PUID` / `PGID` | no | `99` / `100` | Ownership for game files written by the manager (Unraid's `nobody:users` by default). |
| `TZ` | no | `UTC` | Manager clock; also the default for game containers and schedules (overridable in Settings). |

⚙ **Also settable in the UI** (Settings → General → Host & networking). The
environment variable stays the default; a value saved there overrides it, and
clearing the field hands the decision back to the variable. Anything baked into a
game container — networking, the WebUI base URL — applies the next time that server
starts. `HOST_DATA_DIR` applies immediately, to the next server started.


¹ Auto-detected at boot from the manager's own `/data` mount, so leave it blank —
including on Unraid, where the template ships it empty. Only set it if the log says
auto-detection failed, and then it **must** equal the host path you mapped to `/data`
("App data" in the Unraid template). A value that disagrees with that mount sends
every game server's files to a directory you didn't choose; the manager warns about
this at boot and in `GET /api/health`, but it can't override an explicit setting.

### Data layout

Everything lives under your data dir — one directory to back up:

```
/data
├── db.sqlite            # server definitions, schedules, players, settings
├── instances/<id>/      # each server's game files + world saves
├── backups/<id>/        # world snapshots (automatic ones rotated per server)
├── backups/_manager/    # nightly self-backups of db.sqlite (retention in Settings)
└── clusters/<id>/       # ARK cluster transfer dirs
```

Deleting a server from the UI asks whether to wipe its instance + backups, and
offers a browser download of the world saves first.

### Updating

Releases are versioned: every `vX.Y.Z` tag builds and publishes
`ghcr.io/shakes63/palisade:latest` plus matching `vX.Y.Z` / `vX.Y` tags (see
[Releases](https://github.com/Shakes63/palisade/releases) for changelogs). To
update: pull the new image and recreate the container (Unraid's update button
does both). Database migrations run automatically on boot. Prefer a fixed
version over `latest`? Point the template at a specific `vX.Y.Z` tag — any
published release remains pullable as a rollback pin.

**Channels:**

| Tag | Moves when | For |
| --- | --- | --- |
| `latest` | a `vX.Y.Z` release is cut | most people |
| `vX.Y.Z` / `vX.Y` | that release | pinning / rollback |
| `nightly` | a nightly build is manually triggered | early testing, bleeding edge |
| `sha-<short>` | every build | immutable pin of an exact build |

`nightly` is a prerelease of unreleased `main` code (versioned like
`1.3.2-nightly.202607110245`) — expect rough edges, and note it may apply DB
migrations a later rollback to a stable release can't undo (Prisma migrates
forward only), so back up first. It never moves `latest`, so stable users
can't see it. Opting in and out is just which tag your container tracks:
point the image at `ghcr.io/shakes63/palisade:nightly` to ride prereleases,
and back at `:latest` to rejoin stable at the next release.

### Troubleshooting

**Player counts stay empty, or RCON says `getaddrinfo ENOTFOUND <container name>`.**
The manager couldn't resolve the game container by name. Games with no usable query
protocol (Palworld, ASA, Minecraft) read their player list over RCON, so this shows
up as "no players" rather than an obvious error.

Palisade works out how to reach each container from the container itself — its IP on
a network you share, the host gateway when it uses host networking or publishes the
port — so this only bites when none of those apply. The usual cause is the manager
not being attached to `palisade-net` while game servers are. Check `GET /api/health`:
it reports a warning naming this exact condition. To fix:

```bash
docker network connect palisade-net <manager container>
```

On Unraid, make sure the Palisade container's **Network Type** is `palisade-net`
(the template sets it, but it's easy to change). If you use `GAME_HOST_NETWORK=true`,
the manager instead needs `--add-host host.docker.internal:host-gateway`.

### Moving off `ark-net`

The shared bridge was called `ark-net` before v1.11. The rename is not cosmetic: on
Unraid, a container's WebUI link is built from the **first** of its networks sorted by
name, so as soon as Palisade attached itself to `ark-net` it sorted ahead of `br0` and
the button on a custom/macvlan install started pointing at the bridge IP instead of the
LAN one. `palisade-net` sorts after `br0`, `bond0` and `eth0`, so the link stays right.

It migrates itself, and a half-migrated install works throughout:

- New servers are created on `palisade-net`. Existing ones move the next time you
  start them — Palisade recreates the container on every start anyway.
- The manager holds **both** networks until the last server has moved, then drops
  `ark-net` on its next restart. It never lets go early, and never at all when Docker
  is reached through a socket-proxy or another container is still on that network —
  in those cases the Servers page tells you the one step left.
- To keep the old name, set `SHARED_NETWORK=ark-net`.

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

## Security

What's built in:

- **Auth**: single-admin JWT auth (bcrypt cost 12), 7-day tokens carrying a
  version claim checked against the DB on every request — `POST
  /auth/logout-all` instantly invalidates every outstanding token. Login and
  first-run are rate-limited (5/min per client). The realtime socket requires
  the same token; anonymous connections never receive log or console traffic.
- **API**: helmet security headers; CORS denies cross-origin by default
  (browsers reach the API same-origin through the web app). Serving the UI
  from a different origin needs `CORS_ORIGINS` (comma-separated allowlist).
- **Docker access**: least-privilege via
  [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) —
  see `docker-compose.yml`. The manager then only reaches container/image
  endpoints; exec, volumes, networks, build, and secrets are denied at the
  proxy. Note the proxy filters endpoints, not payloads: container creation
  stays possible, so this narrows the blast radius rather than eliminating it.
- **Game containers** run with `no-new-privileges`, a pids limit, and RAM
  caps; console/RCON arguments are sanitized against command injection from
  player-chosen names.
- **Supply chain**: CI blocks the image build on high/critical production
  dependency vulnerabilities (pnpm audit) and Trivy-scans the built image for
  CRITICAL CVEs before pushing; the base image is digest-pinned.
- **Backups** are verified: the manager's nightly DB snapshot must pass
  SQLite's `integrity_check`, and world backups record their size and raise a
  warning event when a snapshot captures no files.

Trade-off to know about: **game-server images are pulled by floating tags**
(usually `:latest`, as their maintainers publish them). That's what keeps
game updates one click away, but it means those images change underneath you
outside Palisade's control. The game containers' runtime caps above (plus
per-container RAM limits) bound what a misbehaving image can do — but treat
game images with the same trust you'd give installing that community image
by hand.

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
| Palworld (Wine — full mods) | `ripps818/docker-palworld-dedicated-server-wine` | [ripps818](https://github.com/ripps818/docker-palworld-dedicated-server) |
| Minecraft (Java) | `itzg/minecraft-server` | [itzg (Geoff Bourne)](https://github.com/itzg/docker-minecraft-server) |
| Minecraft Bedrock | `itzg/minecraft-bedrock-server` | [itzg (Geoff Bourne)](https://github.com/itzg/docker-minecraft-bedrock-server) |
| Icarus | `mornedhels/icarus-server` | [mornedhels](https://github.com/mornedhels/icarus-server) |
| Enshrouded | `mornedhels/enshrouded-server` | [mornedhels](https://github.com/mornedhels/enshrouded-server) |
| Valheim | `lloesche/valheim-server` | [lloesche / community-valheim-tools](https://github.com/community-valheim-tools/valheim-server-docker) |
| 7 Days to Die | `vinanrra/7dtd-server` | [vinanrra](https://github.com/vinanrra/Docker-7DaysToDie) (built on [LinuxGSM](https://linuxgsm.com/)) |
| Project Zomboid | `danixu86/project-zomboid-dedicated-server` | [Danixu](https://github.com/Danixu/project-zomboid-server-docker) |
| V Rising | `trueosiris/vrising` | [TrueOsiris](https://github.com/TrueOsiris/docker-vrising) |
| Sons of the Forest | `jammsen/sons-of-the-forest-dedicated-server` | [jammsen](https://github.com/jammsen/docker-sons-of-the-forest-dedicated-server) |
| Satisfactory | `wolveix/satisfactory-server` | [wolveix](https://github.com/wolveix/satisfactory-server) |
| Life is Feudal: Your Own | `ich777/steamcmd:lifyo` | [ich777](https://github.com/ich777/docker-steamcmd-server/tree/lifyo) |
| American Truck Simulator | `ich777/steamcmd:ats` | [ich777](https://github.com/ich777/docker-steamcmd-server/tree/ats) |
| Euro Truck Simulator 2 | `ich777/steamcmd:ets2` | [ich777](https://github.com/ich777/docker-steamcmd-server/tree/ets2) |
| Core Keeper | `escaping/core-keeper-dedicated` | [escaping.network](https://github.com/escapingnetwork/core-keeper-dedicated) |
| Terraria | `ryshe/terraria` | [Ryan Sheehan](https://github.com/ryansheehan/terraria) (built on [TShock](https://github.com/Pryaxis/TShock)) |
| Factorio | `factoriotools/factorio` | [factoriotools](https://github.com/factoriotools/factorio-docker) |
| Rust | `didstopia/rust-server` | [Didstopia](https://github.com/Didstopia/rust-server) |
| BeamNG.drive | `rouhim/beammp-server` | [RouHim](https://github.com/RouHim/beammp-container-image) (built on [BeamMP](https://beammp.com)) |

Also standing on: [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD),
GE-Proton/Wine for the Windows-only servers,
[Thunderstore](https://thunderstore.io/) (Valheim mod index), and the
[CurseForge](https://www.curseforge.com/) + Steam Web APIs for mod browsing.

## License

[MIT](LICENSE) © 2026 Jacob Neudorf. Not affiliated with Studio Wildcard,
Overwolf/CurseForge, Valve, Iron Gate, The Fun Pimps, Keen Games, RocketWerkz,
Funcom, Pocketpair, Mojang, or Netgate.
