# ARK Server Manager — Build Plan

A self-hosted, Docker-based control panel for ARK dedicated servers (ASA + ASE),
designed to run as a single container on Unraid. It installs servers via SteamCMD,
manages every setting, handles mods + an in-app mod browser, builds clusters,
provides a live RCON console, and runs scheduled tasks.

---

## Decisions locked

| Decision | Choice |
|---|---|
| Games supported | **Both ASE + ASA** (ASA first) |
| Tech stack | **Node/TypeScript full-stack** |
| Runtime model | **Manager spawns one container per game server** (mounts Docker socket) |
| Auth (v1) | **Single admin** (designed so RBAC/multi-user can be added later) |
| Build order | **ASA first**, then ASE |
| Mod browser | **Full in-app browser** using CurseForge API (ASA) + Steam Web API (ASE) |
| UI exposure | **LAN-first but reverse-proxy friendly** (configurable base URL, correct headers) |
| v1 must-haves | **Live RCON console + player admin**, **Scheduled tasks** |
| Backend framework | NestJS (default) — Fastify if we want leaner |
| Scheduler | Redis-free (`node-cron` + in-process queue) by default; BullMQ+Redis only if needed |
| Base game-server image | **Base on a proven community image** (e.g. mschnitzer ASA) for the GE-Proton/SteamCMD layer; custom entrypoint for our manager contract |
| Install execution | **Ephemeral installer container** per install/update (spawn from base image → SteamCMD into shared volume → exits, streaming progress) |
| Security posture (v1) | **Encrypted secrets** at rest in SQLite. Docker via the host socket by default (single-user LAN tool); an optional **socket-proxy** (least-privilege) can front it via `DOCKER_HOST` for hardened/exposed deployments |
| Existing servers | **All greenfield** for v1; "adopt existing instance" import deferred to a later phase |

---

## Confirmed technical facts (the design rests on these)

- **ASA** = SteamCMD app `2430930`. Windows-only binary; **runs via GE-Proton on Linux**
  (no native Linux server exists). Proven reference images exist to build on.
- **ASA mods** install by passing `-mods=id1,id2` — the server **auto-downloads from
  CurseForge** at startup. No API key needed to *install*; the CurseForge API key is only
  for the *browser*. CurseForge game ID for ASA = `83374`. Mod load order matters.
- **ASE** = app `376030`, native Linux. Workshop mods via SteamCMD
  `workshop_download_item 346110 <id>` + extraction of `.z` files into `Mods/` and
  generation of `.mod` files (reuse `ark-server-tools` logic).
- **Ports per server:** Game `7777/udp` (+`7778` raw socket), Query `27015/udp`,
  RCON `27020/tcp`. Clusters share a transfer directory + cluster ID.

---

## Architecture (topology)

```
Unraid host
├── /var/run/docker.sock ──┐
│                          ▼
│   ┌─────────────────────────────────────────────┐
│   │  ark-manager  (the container you install)    │
│   │  ┌─────────────┐  ┌──────────────────────┐   │
│   │  │ Next.js UI  │  │ Node API + WebSocket  │   │
│   │  └─────────────┘  └──────────────────────┘   │
│   │  Orchestrator · Config engine · Mod svc ·    │
│   │  RCON client · Scheduler · SteamCMD jobs     │
│   │  SQLite (manager state)                      │
│   └───────────────┬──────────────────────────────┘
│                   │ Docker API (create/start/stop/logs)
│        ┌──────────┼───────────────────────┐
│        ▼          ▼                        ▼
│  ┌───────────┐ ┌───────────┐         ┌───────────┐
│  │ asa-srv-1 │ │ asa-srv-2 │   ...   │ ase-srv-1 │   ← per-server containers
│  │ Proton+   │ │ Proton+   │         │ native    │     (from base images)
│  │ ARK ASA   │ │ ARK ASA   │         │ ARK ASE   │
│  └───────────┘ └───────────┘         └───────────┘
│
└── Shared appdata volumes:
    steam-asa/ (game files, shared)          steam-ase/
    instances/<id>/{saves,config,logs}       clusters/<id>/ (shared transfer dir)
    backups/                                  steamcmd/ (cache)
```

**Why this shape:** the manager never runs game processes itself — it is a thin,
restart-safe control plane. Game files are installed **once per game** into a shared
volume and mounted into every server container (10 ASA servers ≠ 10× 30 GB). Each server
gets its own writable `instances/<id>` for saves/config/logs. Clusters = a set of
containers that also mount a shared `clusters/<id>` transfer dir and share a cluster ID.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router) + React + TypeScript, shadcn/ui + Tailwind, TanStack Query |
| Backend | Node + TypeScript, NestJS (Fastify alternative) |
| Realtime | WebSocket/SSE for logs, RCON console, install progress, server status |
| DB | SQLite via Prisma (one file in appdata, zero-config) |
| Jobs/scheduler | `node-cron` + in-process queue (Redis-free start); BullMQ+Redis optional |
| Docker control | `dockerode` |
| RCON | `rcon-client` (Source RCON) |
| Mod APIs | CurseForge Core API (ASA), Steam Web API (ASE Workshop) |
| Package manager | pnpm |

---

## Core subsystems

1. **Install/Update service** — spawns an **ephemeral installer container** from the base
   image to run SteamCMD (`app_update 2430930` / `376030`, anonymous login) into the shared
   game-files volume; streams live progress to the UI, validates installs, tracks build IDs,
   flags available updates. Keeps the manager image lean and game-runtime deps out of it.
2. **Container orchestrator** — builds the run spec (image, env, volume mounts, port maps,
   resource limits, assembled ARK command line) and drives create/start/stop/restart/remove
   via dockerode. Reconciles desired vs. actual state on manager boot.
3. **Config engine** — schema-driven settings management (see below).
4. **Mod service** — ASA: writes `-mods=`, triggers CurseForge auto-download, tracks
   installed/active mods + load order. ASE: SteamCMD Workshop download + extract/install +
   `.mod` generation.
5. **RCON service** — connection pool per running server; powers live console, player list,
   kick/ban/whitelist, broadcast, `saveworld`, `doexit`.
6. **Cluster manager** — create cluster → shared transfer dir + cluster ID → add/remove
   members → coordinated start/stop; cross-server transfer via the shared cluster volume.
7. **Scheduler** — cron-style restarts and auto-updates with in-game countdown warnings
   (RCON broadcast), graceful `saveworld` + `doexit`, and a **mandatory pre-update save
   snapshot** (see backups caveat).
8. **Mod browser** — searchable UI backed by CurseForge (ASA) and Steam Workshop (ASE):
   thumbnails, descriptions, versions; "Install" wires into the mod service.
9. **Logs/telemetry** — tail container + ARK logs, parse player join/leave + chat, surface
   per-container CPU/RAM, online/offline + player count.
10. **Auth** — single admin (hashed credential + session/JWT); structured so RBAC drops in later.

---

## Manager ↔ server-container contract (the core interface)

The boundary between the orchestrator and each game-server container, defined explicitly:

- **Config delivery:** the manager renders `GameUserSettings.ini` / `Game.ini` onto the
  mounted `instances/<id>/config` volume and passes the **assembled launch command** (map +
  `?Option=` query params + `-flags` + `-mods=`) to the container. Env vars only for a few
  bootstrap values (paths, ports, server id).
- **Readiness:** the container is not "up" when Docker says so — readiness is detected by
  **log-parsing** the ARK output (server listening / "has successfully started"). ASA boots
  slowly, so this is required for accurate status.
- **Graceful shutdown:** RCON `saveworld` → `DoExit` → `SIGTERM` with a timeout fallback, so
  stops/restarts never corrupt saves.
- **Crash handling:** **manager-owned watchdog** (not Docker's restart policy) so it can take
  a save snapshot, warn players, and apply a **restart-loop guard** (back off after N rapid
  crashes instead of thrashing).
- **Concurrency locks:** per-volume locks prevent update-while-running and two installs
  racing the same game-files volume.

## Server lifecycle & state machine

**Boot reconciliation:** game containers keep running while the manager is down
(`RestartPolicy=no`, but we never stopped them), while the log/crash monitors + RCON live only
in memory. On startup (`ServersService.onApplicationBootstrap` → `reconcile()`) the manager
lists `ark.role=server` containers and snaps reality back: running ones are re-adopted (DB
re-linked + monitors re-attached; Starting is promoted to Running if the logs already show the
ready marker), vanished/exited ones are cleaned up and marked Stopped/Crashed. State changes
that aren't legal lifecycle transitions (e.g. Stopped→Running) go through
`StateMachineService.force()`, which still logs an event.


Canonical states surfaced in the UI and persisted on the `Server` entity:

```
Installing -> Stopped -> Starting -> Running -> Stopping -> Stopped
                              Running -> Crashed -> (watchdog) Starting | Stopped
Updating: Stopped -> Updating -> Stopped   (scheduled = snapshot-first)
```

Transitions are the only way state changes; every transition logs an event (feeds the
future notifications/audit systems).

---

## Config management (schema-driven)

"Manage every setting available" only works if it is data-driven, not hand-built forms:

- A declarative **settings catalog** (JSON/TS) describes every setting: key, target
  (`GameUserSettings.ini` section / `Game.ini` section / command-line / dynamic config),
  type, default, valid range, category, applicable game(s), and help text.
- The UI **renders from the catalog** — grouped, searchable, validated — so adding a setting
  is a data change, not a code change.
- The backend **serializes** values into the three real targets: `GameUserSettings.ini`,
  `Game.ini`, and the launch command line (`?Option=` query params + `-flags`).
- **Raw passthrough escape hatch:** per-server free-text INI/args override so *nothing is
  ever blocked* — anything the catalog does not yet know can still be set. Guarantees "every
  setting available" on day one even before the catalog is complete.
- **Presets/profiles:** save a config as a template, apply across a cluster, diff vs. defaults.

**First-class server fields** (promoted out of the generic catalog because they need
dedicated UX or wiring):

- **Map** — official maps *and* mod maps (a mod map requires both the map name and its mod ID
  set together; the UI couples them).
- **Passwords** — `ServerAdminPassword` (also required for RCON), join password, spectator
  password. Distinct from the manager admin login; stored encrypted.
- **RCON auto-enable** — manager injects `?RCONEnabled=True?RCONPort=<allocated>` + the admin
  password automatically so the v1 RCON console can connect. (RCON is non-optional internally.)
- **Identity/discovery** — session/server name, `Multihome`/bind IP, BattlEye toggle.

---

## Networking & ports (Unraid)

- Bridge networking + explicit port maps; the manager owns a **port pool** and allocates a
  unique block per server (Game / Game+1 / Query / RCON). Defaults editable, e.g.:
  - server 1 → `7777/7778/27015/27020`
  - server 2 → `7787/7788/27017/27021`
- UI surfaces required port-forwards per server (UDP game/query to players; RCON internal).
- **To verify (Phase 1):** ASA uses **EOS (Epic Online Services)** for server discovery, so the
  legacy Steam **query port may be vestigial** for ASA — confirm before treating it as required.

---

## Storage layout (`/mnt/user/appdata/ark-manager/`)

```
db.sqlite · steamcmd/ · steam-asa/ · steam-ase/
instances/<serverId>/{Saved/, config/, logs/}
clusters/<clusterId>/
backups/<serverId>/
```

- **PUID/PGID:** honor Unraid's `99:100` (nobody:users) convention via env so files on the
  appdata share are owned correctly; the manager and every spawned container run as that uid/gid.
- **Resource limits:** ASA needs roughly **8–16 GB RAM per server** — define sensible default
  RAM/CPU caps per instance, enforce them on the container, and surface them in the UI.
- **Disk-space monitoring:** game files + backups grow fast; show free-space warnings and a
  per-server footprint.

---

## Backups caveat (important)

Full backups are deferred from v1, but **scheduled restarts/updates without a snapshot can
corrupt ARK saves**. So v1's scheduler will always take a **pre-update/pre-restart save
snapshot** (RCON `saveworld` → copy `Saved/`) even before the full backup UI ships. The full
retention/rotation/restore system lands in Phase 5.

---

## Data model (entities)

`Server`, `Cluster`, `Mod` + `ModInstall` (per-server, with load order + optional version
pin), `Schedule`, `Snapshot/Backup`, `SettingProfile`, `User`, `PortAllocation`, `Job`
(install/update/transition), `EventLog` (every state transition + config change — lightweight
audit even in single-admin mode).

**Secrets** (CurseForge key, Steam Web API key, server admin/join/spectator passwords) are
**encrypted at rest** in SQLite, decrypted only in memory at use time.

## Security posture (v1)

- **Docker access:** the manager mounts the host socket directly by default. Since it
  must create containers (≈ host-root regardless), a socket-proxy is defense-in-depth,
  not a hard boundary — so it's **optional** (front Docker with one and set `DOCKER_HOST`
  to `tcp://socket-proxy:2375` for hardened/internet-exposed deployments).
- **Encrypted secrets at rest** (see above).
- **Reverse-proxy friendly:** configurable base URL + correct forwarded headers so it can move
  from LAN-only to behind Nginx Proxy Manager/Traefik + TLS without rework.

## Operational lifecycle

- **First-run onboarding wizard:** create admin, set base paths, enter the CurseForge + Steam
  API keys. (CurseForge requires an **application-gated "Eternal" API key** from
  console.curseforge.com — request it early; the Steam Web API key is instant.)
- **Manager self-update:** documented container-update path; DB migrations run on boot.
- **Scheduler timezone:** explicit TZ setting so cron restarts/updates fire when intended.
- **Mod update control:** ASA mods auto-update by default; expose optional **version pinning**
  per `ModInstall` for admins who need stability.

---

## Phased roadmap

> **Status (2026-06-15):** Phases 0–5 implemented, typechecked, unit-tested, and
> exercised against a live API. The only steps not runnable off-host are the
> Docker/Proton runtime bits (real container spawn, ASA mod auto-download, ASE
> Workshop extraction), which are marked TODO and validated on a real Unraid host.

| Phase | Deliverable |
|---|---|
| **0 — Scaffold** | pnpm monorepo, Next.js + Nest, Prisma/SQLite, dockerode via **socket-proxy**, **encrypted-secrets** helper, Dockerfile + Unraid template, single-admin auth, **first-run onboarding wizard** (paths + API keys), WebSocket plumbing. |
| **1 — ASA single server end-to-end** ⭐ | Base ASA image on a proven community image. **Ephemeral installer container** → schema-driven config → create/start container with the manager contract (config delivery, **log-parse readiness**, **graceful shutdown**, watchdog) → status + log tail → **live RCON console + player admin** → **scheduler** (restart/update + pre-save snapshot). The vertical slice that proves the architecture. |
| **2 — Mods + mod browser** | Install-by-ID pipeline (ASA `-mods=`), load-order + optional version-pin UI, then CurseForge-backed browser. |
| **3 — Clusters** | Cluster create, shared transfer dir, member management, coordinated control, cross-server transfer. |
| **4 — ASE support** | Native ASE base image, SteamCMD Workshop install/extract, Steam Workshop browser, ASE settings catalog. |
| **5 — Backups, notifications, polish** | Full backup retention/restore UI, **adopt-existing-instance import**, Discord/webhook events, reverse-proxy hardening + TLS docs, RBAC/multi-user. |

---

## Top risks

- **Proton/ASA stability** — pin GE-Proton versions; lean on a proven base image rather than
  rolling Proton from scratch.
- **Docker-socket security** — the manager effectively has root on the host; mitigated from
  day one via a **least-privilege socket-proxy** (decided), not the raw socket.
- **ARK update churn** — config keys and mod mechanics shift between patches; schema-driven
  catalog + raw passthrough keeps it resilient.
- **First-mod-launch latency** — ASA's first start with mods is slow; show clear progress.

---

## Reference images / prior art

- mschnitzer/ark-survival-ascended-linux-container-image — https://github.com/mschnitzer/ark-survival-ascended-linux-container-image
- azixus ASA Docker — https://azixus.github.io/ARK_Ascended_Docker/
- acekorneya/POK (asa_server) — https://hub.docker.com/r/acekorneya/asa_server
- ARK official wiki (dedicated server) — https://ark.wiki.gg/wiki/Dedicated_server_setup
- ASA mod install reference — https://xgamingserver.com/docs/ark-survival-ascended/installing-mods
- ASA port-forward guide — https://guides.gsh-servers.com/ark/ark-survival-ascended/how-to-port-forward-ark-survival-ascended
- ark-server-tools (ASE arkmanager) — https://github.com/arkmanager/ark-server-tools

---

## Immediate next step

Scaffold **Phase 0** (pnpm monorepo, Next.js + Nest, Prisma schema, dockerode + RCON wiring,
Dockerfile, Unraid template), then go straight at the **Phase 1 ASA vertical slice**.

---

## Real-host validation (2026-06-16, Unraid 7.2.2, x86_64)

Ran a full ASA test on a real Unraid box. **Result: ASA installs, boots under Proton, and
serves RCON.** Key findings + the resulting runtime pivot:

**The runtime decision changed.** The proven ASA base images (the maintained one is
`acekorneya/asa_server`, POK) are NOT a passive base we pass a `Cmd` to — they are a
complete, **env-var-driven** stack (`/tini -- init.sh` does install + Proton launch). So our
original "assemble argv → container `Cmd` + ephemeral installer" contract does NOT drive them.
**Decision: orchestrate POK via env vars** (keep our config UI/catalog/scheduler/clusters/
RCON; stop owning Proton).

**Verified POK contract** (for the runtime-spec rework):
- Image: `acekorneya/asa_server:2_1_latest` (~10 GB; installs ~13 GB game files on first boot).
- Runs as **uid 7777**, also in group `users(100)`. Mount the instance volume owned `:100`
  with group-write (`chmod 775`) so it's writable AND stays Unraid-friendly. POK ignores PUID
  for the uid. Bind from `/mnt/cache/appdata/...` (the disk), not `/mnt/user` (FUSE).
- Add `--ulimit nofile=100000` (POK warns it can't raise the fd limit otherwise).
- **Env vars:** `INSTANCE_NAME, MAP_NAME, SESSION_NAME, SERVER_ADMIN_PASSWORD, SERVER_PASSWORD,
  ASA_PORT, RCON_PORT, RCON_ENABLED=TRUE, MAX_PLAYERS, MOD_IDS, CLUSTER_ID, BATTLEEYE,
  CUSTOM_SERVER_ARGS, TZ`. POK builds the launch line itself.
- **Map names:** POK passes through anything ending in `_WP`, so our catalog values
  (`TheIsland_WP`, …) work directly via `MAP_NAME`.
- **Config injection (verified end-to-end):** we render INIs to
  `…/ShooterGame/Saved/Config/WindowsServer/{Game,GameUserSettings}.ini` every start. POK's
  backup-dir + symlink relocation is **gated on `BACKUP_DIR`** — which we deliberately do NOT
  set, so the live files stay real files that ARK reads directly. From reading POK's scripts +
  a real sentinel boot:
  - **Game.ini** is never touched by POK (sha256 identical before/after boot). All gameplay
    settings pass through verbatim.
  - **GameUserSettings.ini** survives POK's launch overlay, which only (a) rewrites
    `ServerPassword` from the `SERVER_PASSWORD` env (we pass the same value — consistent), and
    (b) strips `[MessageOfTheDay]`, re-adding it only when `ENABLE_MOTD=TRUE`. Every other key
    (DifficultyOffset, XPMultiplier, custom sections, …) is preserved.
  - ⇒ **MOTD must be routed through POK env** (`ENABLE_MOTD`/`MOTD`/`MOTD_DURATION`) or it's
    dropped — done in `buildPokSpec` (`readMotd`).
- **Cluster (verified, two-server boot):** POK turns `CLUSTER_ID` into `-clusterid` but **never
  sets `-ClusterDirOverride`** — so separate containers wouldn't share a transfer dir. The manager
  mounts one shared host dir (`clusters/<id>`) into every member at `/home/pok/clustershared`
  and appends `-ClusterDirOverride=/home/pok/clustershared` to `CUSTOM_SERVER_ARGS`. Validated by
  booting **two ASA servers in one cluster** sharing the dir: both live `ArkAscendedServer.exe`
  cmdlines carry the same `-clusterid` + `-ClusterDirOverride`, and both processes (uid 7777)
  read/write the same shared mount (the three requirements for cross-server transfers). One server
  reached RCON-ready in-window; the actual in-game character/dino handoff needs a game client
  (ARK only writes to the cluster dir on a real upload), so that byte-level step is out of
  automated scope. The manager chowns dirs it creates to the runtime uid via `makeServerWritable`,
  since the images don't chown their own mounts.
- **Volume:** instance data → `/home/pok/arkserver` (install + saves + config all under it). POK
  is one-install-per-volume, so game files aren't *shared* live — but we avoid re-downloading
  them per server via a reflink cache (below).
- **Readiness markers (verified):** `has successfully started!` then `Full Startup: <n>s`
  (our `READY_RE` updated). `Steam Subsystem … FAILED` / `Region ""` is NORMAL for ASA (EOS,
  not the Steam query port — query port confirmed vestigial).
- The real launch line POK ran matches our `buildLaunchArgs` shape, so our launch syntax was
  correct; RCON validated externally (`ListPlayers`, `Broadcast`, `SaveWorld` all worked).

**Rework scope (Path A):** `common/images.ts` → POK image; `servers/runtime-spec.ts` → POK env
vars + volume + ulimit (not `Cmd`); drop the ephemeral installer for ASA (POK installs on boot);
write rendered INIs into the POK config path; keep RCON/state-machine/scheduler/clusters.

### ASE runtime (hermsi/ark-server) — same env-driven + config-injection model

ASE got the same treatment as ASA: the placeholder image (`arkmanager/ase-server`, which doesn't
exist) is replaced by the proven, maintained **`hermsi/ark-server`** (arkmanager-based), driven
env-driven with config injection rather than an assembled `Cmd`. Verified against the image's
entrypoints + a real install on the box:
- **Self-installing:** entrypoint `/docker-entrypoint.sh` → `gosu steam /steam-entrypoint.sh`
  runs `arkmanager install` / `installmod` / `update` on first boot. So "install" is just an
  image pull (same as POK); the ephemeral SteamCMD installer + workshop pre-download are gone.
- **Runs as uid/gid 1000 (steam)**; chowns only the volume root, so the manager makes the
  injected config dir/INIs writable by 1000 (`makeServerWritable`, generalized from the POK 7777
  case via `SERVER_UID`/`SERVER_GID`).
- **Volume `/app`** (`HERMSI_VOLUME`); game files install under `/app/server`, manifest
  `appmanifest_376030.acf`, INIs at `server/ShooterGame/Saved/Config/LinuxServer/` (where
  `writeInis` now renders them for ASE).
- **Env contract:** `SESSION_NAME, SERVER_MAP, ADMIN_PASSWORD, SERVER_PASSWORD, MAX_PLAYERS,
  GAME_MOD_IDS, GAME_CLIENT_PORT, UDP_SOCKET_PORT, RCON_PORT, SERVER_LIST_PORT, UPDATE_ON_START,
  DISABLE_BATTLEYE`. RCON is on by default in its instance template.
- **Cluster:** hermsi exposes no cluster env, so (like POK) the manager mounts the shared dir at
  `/clustershared` and forwards the flags via arkmanager's `--arkopt,` Cmd passthrough. Confirmed
  against arkmanager's `addArkOpt`: `--arkopt,-clusterid=X` → `arkopt_clusterid` → `-clusterid=X`
  and `--arkopt,-ClusterDirOverride=/clustershared` → `-ClusterDirOverride=/clustershared` on the
  launch line (the leading dash is required — without it the token routes to an `ark_` config var
  instead). The shared-dir filesystem mechanism is identical to the two-server-validated ASA case.
- **Validated end-to-end on the box:** image pull → hermsi installs the ~21 GB ASE files into
  `/app/server` (manifest `appmanifest_376030.acf`) → arkmanager launches ShooterGameServer with
  our env-mapped settings (`SessionName`, `Port`, `QueryPort`, `RCONPort`, `ServerAdminPassword`,
  `MaxPlayers`) → "server is up" → **RCON serves read + write** (`ListPlayers` → "No Players
  Connected", `SaveWorld` → "World Saved"). The `[S_API FAIL] SteamAPI_Init()` line is normal for
  ASE dedicated (no Steam client). Game-file reflink caching is currently ASA-only; ASE can reuse
  the same mechanism later.

### Game-file caching (reflink) — avoids the ~13 GB download per server

POK installs ~13 GB into **each** server's own volume on first boot, so a naive setup
re-downloads the game for every server. We make it effectively one-time:

- **First server seeds a golden cache.** When the first ASA server reaches "ready"
  (`onReady`), `InstallerService.seedGameFilesCache()` snapshots its install into
  `DATA_DIR/cache/asa`, pruning the per-server world/config (`ShooterGame/Saved`) and POK's
  runtime state (`instance_flags`, `update_coordination`, `steamapps/temp`). Process-local
  guard + atomic `rename` of a `.seeding` staging dir → the cache only appears complete once,
  and only seeds while empty.
- **Every later server clones the cache.** Before start (`prepareGameFiles()`, pre-`writeInis`),
  if the instance has no `appmanifest_2430930.acf` but the cache does, we clone the cache into
  the instance. POK then finds the manifest present and boots straight to launch (no download).
- **Clone mechanism:** `cp -a --reflink=auto <cache>/. <instance>` — `-a` preserves the
  `7777:7777` ownership POK needs; `--reflink=auto` is an instant copy-on-write clone on
  btrfs/XFS and silently degrades to a full copy elsewhere. If `cp` lacks the flag (BSD cp in
  dev), it falls back to Node's `fs.cp`. Correct on any host; instant + ~0 disk on btrfs/XFS.
- **Verified on the real box (btrfs cache):** cloning the 13 GB install took **0.032 s** with
  **no change in free space** (363 G → 363 G — true CoW), ownership preserved as `7777:7777`,
  and pruning leaves a clean base (manifest + binaries, no `Saved`). Reflink requires src+dst on
  one filesystem, so the cache and instances both live under `DATA_DIR`.
- **Updates:** still per-server Steam deltas on boot (small); CoW means only changed blocks cost
  real disk. Non-btrfs hosts fall back to full copies (correct, just not free).
