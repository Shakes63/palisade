# Conan Exiles

**Image:** `acekorneya/conan_enhanced_server:latest` (by acekorneya, same family as the ASA image — native Linux server) · **Ports (defaults):** 7777/udp game, 7778/udp raw socket, 27015/udp query (server browser), 27020/tcp RCON (LAN-only, not forwarded)

**Join:** In Conan: Server list → Direct Connect, paste `<ip>:27015` — Conan's Direct Connect takes the QUERY port, not the game port (there is no `open` console command). It accepts the join password at the prompt. Or search Online → Server List by name with Show Password Protected on if applicable.

**Admin:** RCON. The admin password field is the server admin password and also authenticates RCON (`RCON_PASSWORD` is set to it); the panel's Console tab and player counts use it.

## First boot
Conan's install is famously large — ~40 GB (45 GB disk preflight); expect a long first install. Plan ~7 GB RAM for a populated server. The image installs the native Linux server (app 443030) plus Steam Workshop mods via SteamCMD on boot. Config is delivered as env vars — the image writes ServerSettings.ini / Engine.ini / Game.ini itself; Palisade renders no INIs. Only settings you change from the catalog default are sent, so untouched knobs keep the game's own vanilla defaults. Ready is detected on the one-shot log line `Startup report. StartupTime=` — the true joinable moment; the earlier "Rcon is ready" / engine-init lines fire ~30 s too soon. One map ships (ConanSandbox = Exiled Lands); the server hard-caps at 40 players.

## Gotchas
- Direct Connect uses the query port (27015), not 7777 — the most common join mistake.
- The image declares `VOLUME /data/server`, `/data/steam`, `/data/backups`; Palisade binds each subdir explicitly, because without that Docker shadows them with anonymous volumes and the game install + world saves are silently lost on every container recreate (and invisible to backups).
- Game updates are a one-shot: the manager runs with `AUTO_UPDATE=false` (it owns the lifecycle), so game files only update when you click Install/Update and then restart — that start forces `AUTO_UPDATE=true` exactly once (with the in-session update monitor disarmed).
- The image's own watchdog, auto-update, and daily-restart loops are disabled — the manager's watchdog owns restarts.
- Mods are Steam Workshop (consumer app id 440900), passed as `MOD_IDS` and downloaded by the image on start.
