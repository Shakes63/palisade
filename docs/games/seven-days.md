# 7 Days to Die

**Image:** `vinanrra/7dtd-server` (LinuxGSM-wrapped, by vinanrra) · **Ports (defaults):** 26900/tcp+udp (game), 26901/udp (game +1), 26902/udp (Steam query / server browser), 8081/tcp (telnet console — LAN-only, not forwarded)

**Join:** In 7 Days to Die: Join a Game → Connect to Server, enter the server IP and port 26900, or search the server browser by name. Online, friends use your public IP with the same port. Enter the join password when prompted.

**Admin:** Telnet console on 8081/tcp, not Source RCON — the admin password field sets the telnet password and gates the in-app Console (exec/players/save/kick/ban/broadcast all work through it). 7DTD command syntax: `say "msg"`, `listplayers`, `kick "name"`, `ban add "name"`.

## First boot
LinuxGSM installs the game via SteamCMD on the first start — roughly 17 GB, about 13 minutes. The server is Running once the log prints `StartGame done` (the earlier "Started Telnet on 8081" line fires ~60 s before the world is actually joinable). The map field picks Navezgane (handcrafted) or RWG (random world generation from a seed). A pinnable VERSION setting selects the Steam branch (stable / latest_experimental).

## Gotchas
- This game is not env-driven: settings live in `sdtdserver.xml`, which Palisade renders fresh before every managed start. Hand edits to that file are clobbered — change settings through the panel.
- Unknown property names in the config are fatal ("Unknown config option" → shutdown). The catalog is the live-verified 61-property set; note the correct key is `QuestProgressionDailyLimit`, and many accepted GamePrefs (GameDifficulty, BloodMoon*, ZombieMove...) are absent from the shipped serverconfig.xml template.
- Mods are drop-in folders under `serverfiles/Mods` (the Mods tab accepts .zip uploads). The game ships its own TFP_* mods in that dir — leave them alone.
- Data is split: `serverfiles/` holds the ~20 GB install + config, `saves/` holds the world and player data. Backups target only the small saves dir.
- The image's startup unconditionally installs an (empty) crontab, and the write fails fatally under the container's no-new-privileges hardening, so Palisade mounts a world-writable tmpfs over `/var/spool/cron/crontabs` — don't remove it.
- The telnet port (8081) is deliberately excluded from the forwarding spec — keep it LAN-only.
