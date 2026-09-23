# Valheim

**Image:** `lloesche/valheim-server:latest` (by lloesche — native Linux, installs the server via SteamCMD on boot) · **Ports (defaults):** 2456/udp game, 2457/udp query (server browser), 2458/udp crossplay; plus 2459/tcp HTTP status (player counts — LAN-only, not forwarded)

**Join:** In Valheim: Start Game → (character) → Join Game → Join IP with `<ip>:2456`, or search the Community server list by name (public listing is on by default; it can take a minute to appear). Valheim always requires the join password.

**Admin:** None — no RCON, so the Console tab is hidden and save-on-stop is a no-op. There is no admin password field; Valheim admins are a Steam-ID allowlist (the admin list file in `/config`, editable via the panel's access lists).

## First boot
Light and quick: the image SteamCMD-downloads the server and generates the world in ~100 s on first boot (~3 GB disk, ~2–4 GB RAM populated). Ready is detected on the log line `Game server connected`. One procedurally generated world from a seed — no map choice. Player cap is a hard 10 (Iron Gate's P2P design). Unity shader/IMGUI errors in the boot log are benign (headless server, no GPU).

## Gotchas
- A join password of at least 5 characters is REQUIRED or the server won't boot — the create form enforces it.
- Valheim does not answer direct A2S on its query port (queries go through Steam's relay), so Palisade reads player counts from the image's own HTTP status endpoint on game port + 3 (2459) instead. That port stays LAN-only.
- World modifiers (preset / modifiers / keys) are LAUNCH FLAGS, not env vars — the "World modifiers" settings compile into the image's `SERVER_ARGS` (`-preset X`, `-modifier name value`, `-setkey name`).
- Mods come from Thunderstore and Hexium via the panel's mod browser: installs land in `config/bepinex/plugins/<Owner-Mod>/` with dependencies resolved across both, and BepInEx is auto-enabled. When a mod is on both, the Thunderstore package is used unless its author deprecated it there (usually because they moved to Hexium). Players must run the same mods locally (r2modman or Gale).
- Valheim is one of only two games (with Minecraft) in the mod-updater's scope — out-of-date Thunderstore and Hexium plugins are detected, badged, and updatable in bulk or on a schedule.
- The container runs as root (lloesche's default; PUID/PGID unset) — this is expected, and it's why the root-owned instance binds work without a chown.
