# V Rising

**Image:** `trueosiris/vrising` (by trueosiris; Windows server under Wine) · **Ports (defaults):** 9876/udp (game), 9877/udp (Steam query / server browser), 25575/tcp (Source RCON — LAN-only, not forwarded)

**Join:** In V Rising: Play → Online Play → Direct Connect — paste the server IP and port 9876. Or search the server list by name if listing is enabled in the server settings. Online, friends use your public IP with the same port.

**Admin:** Source RCON on 25575/tcp — the admin password field enables the in-app Console and sets the RCON password. V Rising's RCON is limited: `announce` works (and returns an empty response on success), but there are no player-list/save/kick commands — player counts come from A2S queries and saves ride the autosave plus a graceful SIGTERM stop.

## First boot
The image installs the game (~2 GB) via SteamCMD on the first start. The server is Running at the log line `Server connected to Steam successfully!`. The world is Vardoran (single fixed map); the supported player ceiling is 40 (MaxConnectedUsers). Settings are env-driven: `HOST_SETTINGS_`/`GAME_SETTINGS_` variables patch the two settings JSONs in `persistentdata` on boot.

## Gotchas
- First-boot SteamCMD flake: `Failed to install app '1829350' (Missing configuration)` can fail several boots in a row (the image's start script doesn't retry). If a fresh server crash-loops, just keep retrying start — Palisade's crash watchdog restarts ARE the retries; it may take a few.
- A2S player counts only work with `ListOnSteam=true` — an unlisted server binds the query port but never reads the socket, so counts show null until listing is on.
- A `wine: Assertion failed` line during boot is non-fatal — the server keeps loading chunks; don't treat it as a crash.
- The image's `/start.sh` ships with CRLF line endings; Palisade overrides the entrypoint to strip them before exec (harmless once upstream fixes it — don't remove the override until then).
- Data is split: `server/` (game install) and `persistentdata/` (saves + settings JSONs). Backups target only persistentdata.
- The difficulty preset is applied after the game settings preset, so a setting both define comes from the difficulty preset (e.g. `Difficulty_Brutal` resets `DurabilityDrainModifier` even if a custom game settings preset zeroes it).
