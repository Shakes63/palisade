# Palworld

**Image:** `thijsvanloef/palworld-server-docker` (by thijsvanloef; native Linux server) · **Ports (defaults):** 7777/udp (game), 7779/udp (Steam query), 7780/tcp (RCON — LAN-only, not forwarded)

**Join:** In Palworld: Join Multiplayer Game (Dedicated) → Connect with IP, paste the server IP and port 7777. Online, friends use your public IP with the same port. Enter the join password when Palworld prompts for the server password.

**Admin:** Source RCON on 7780/tcp — the admin password field enables RCON and is also the RCON password (the image wires `ADMIN_PASSWORD` into rcon.yaml). Palisade uses RCON (`ShowPlayers`) for live player counts.

## First boot
The image installs the game (Steam app 2394010) via SteamCMD on the first start — budget roughly 8 GB of disk. The server is Running at the log line `Running Palworld dedicated server on :<port>`, which is the actual joinable moment. There is one fixed world (Palpagos Islands), no map choice; player cap is 32 (dedicated-server hard cap).

## Gotchas
- Game files do NOT auto-update after install: SteamCMD-on-start is the only update path and `UPDATE_ON_BOOT` defaults to false. Use the panel's Install/Update — it sets a one-shot flag that forces the update env on the next start.
- Mods: only Lua/Blueprint mods work via UE4SS on this native Linux variant. DLL mods (PalGuard, PalDefender) cannot load into a native process — they need the separate Palworld (Wine) variant.
- The one-click UE4SS install uses the experimental Linux fork (v3.0.1, pinned + checksum-verified) and scopes `LD_PRELOAD` to the `PalServer.sh` launch line only. A container-wide preload segfaults every other process (exit 139 with no logs) — don't set it yourself.
- There is no browse-and-install mod source for Palworld dedicated servers (not on Steam Workshop; Nexus gates downloads). The Mods tab offers a `.pak` uploader, the UE4SS toggle, and curated links to the established server mods instead.
- The auto-pause toggle hard-requires the image's player logging + REST API; Palisade enables both automatically with it (the REST API stays unpublished).
- Waking a paused server relies on a packet monitor (`knockd`) that the image runs as its non-root user via a file capability on the binary. That is incompatible with the `no-new-privileges` hardening every other game container gets, so with auto-pause on this one container runs without it and with `NET_RAW` granted explicitly (GH #58 — before this, the server paused and then never woke). On host networking that monitor can see the host's interfaces; that is inherent to how the image wakes.
- The image refuses to run as root — it runs as the non-root PUID/PGID user.
