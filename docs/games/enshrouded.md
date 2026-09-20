# Enshrouded

**Image:** `mornedhels/enshrouded-server` (by mornedhels; Windows server under Proton) · **Ports (defaults):** 15636/udp (game), 15637/udp (Steam query / server browser)

**Join:** In Enshrouded: Play → Server List → Join IP, paste the server IP and port 15637 — joining uses the query port, not the game port — or search the server list by name. Online, friends use your public IP with the same port. Enter the join password to play as Guest; append `-admin` to it for admin rights.

**Admin:** None — no RCON and no console (the Console tab is hidden). There is no admin password field: the admin role is derived from the join password. Palisade defines three roles from the single join password — Guest (`<pw>`), Friend (`<pw>-friend`), and Admin (`<pw>-admin`, can kick/ban).

## First boot
Install only pulls the image; the game files download via SteamCMD on the first start (~8.9 GB, about 5 minutes). The server is Running at the log line `'HostOnline' (up)!`. The world is a single procedurally generated map — no map choice. A join password of at least 5 characters is required. Player slots cap at 16 (SERVER_SLOT_COUNT hard range).

## Gotchas
- The join password is role-based (`SERVER_PASSWORD` is deprecated). Palisade overwrites all three shipped roles with unique passwords derived from your join password — role passwords must be unique or the server crashes on boot, which the `-friend`/`-admin` suffixes guarantee.
- Savegame path: the image installs the game under `/opt/enshrouded/server`, so the save lands at `gamefiles/server/savegame` inside the instance dir. The dir stays empty until the first autosave tick (log `[server] Saved`) or a graceful stop — a backup taken before then captures nothing.
- Difficulty knobs only take effect when the preset is set to Custom (`SERVER_GS_PRESET=Custom`); otherwise the individual settings are ignored by the game.
- The three duration settings (hunger-to-starving, day/night length) are edited in minutes in the panel but the game wants nanoseconds — Palisade converts on the way out; don't set raw nanosecond values.
- No mod support at all (the Mods tab is hidden).
- Same Proton family as Icarus: the host needs `vm.max_map_count=262144`.
