# Icarus

**Image:** `mornedhels/icarus-server:latest` (by mornedhels — installs the Windows server via SteamCMD and runs it under Wine) · **Ports (defaults):** 17777/udp game, 27015/udp query (server browser)

**Join:** In Icarus: Play → Join IP with `<ip>:17777`, or find the server by name in the in-game browser (Play → Join Server). Prefer the browser: the query port always listens so the lobby lists, but the game port only binds once a prospect is active — join via the browser into the lobby rather than a raw Join-by-IP.

**Admin:** No network RCON — admin is in-game chat only. The admin password field gates the in-game `/AdminLogin` command (then `/AdminSay`, `/KickPlayer`, ...). The Console tab, live player list, broadcast, and save-on-stop are hidden/disabled for Icarus.

## First boot
- ~11 GB of game files via SteamCMD under Wine (15 GB disk preflight) — expect a long first install. Icarus is heavy at runtime too: RocketWerkz recommend 16 GB RAM; the panel budgets 12 GB.
- There is no map or world to configure: the world is a "prospect" (map + mode + difficulty) that players create/select in-game from the lobby. `SERVER_ALLOW_NON_ADMINS_LAUNCH` and `SERVER_RESUME_PROSPECT` control lobby behavior. To boot straight into a saved prospect, set **Load prospect on start** (Settings → Session) to its name.
- Ready is detected when the Unreal server binds its port and the GameMode reaches the lobby ("Match State Changed from EnteringMap to WaitingToStart").
- Config + saves (prospects) and the big game install are bound to separate dirs, so backups target the small config/saves dir.

## Gotchas
- Host requirement: the Docker host needs `vm.max_map_count=262144` (Linux default is 65530) or Icarus OOMs on boot. On Unraid, persist it via a `sysctl -w` line in `/boot/config/go`.
- Mods are community Unreal `.pak` files (NexusMods / Project Daedalus), not Workshop — hence the panel gives you an uploader, not a browser. Uploads land in `gamefiles/server/Icarus/Content/Paks/mods`.
- Two hard mod rules: every player needs the same mods installed locally, and multiple mods must be merged into a single `._P.pak` (with Icarus Mod Manager) before upload.
- Port forwarding needs BOTH UDP ports: 17777 (game) and 27015 (query) — 27015 is the one that makes the server appear in the in-game browser.
- Player cap is 20 (RocketWerkz raised it from 8); the create form defaults to 8.
- Editing `LoadProspect=` in `ServerSettings.ini` by hand does not stick: the image blanks that line on every boot. Use the **Load prospect on start** setting instead, which re-applies it after the image's reset. Every other line in that file the image does not manage survives restarts and can be edited from the Files tab.
