# Euro Truck Simulator 2

**Image:** `ghcr.io/ich777/steamcmd:ets2` (by ich777) · **Ports (defaults):** 27018/udp (connection), 27019/udp (Steam query / session search) — a deliberately shifted block, disjoint from ATS's 27015/27016

**Join:** In Euro Truck Simulator 2, open **Convoy → search sessions** and find the server by name (up to 8 players — SCS's hard Convoy cap). Everyone joining needs the **same map DLCs** as the server's world export. Enter the session password if one is set — it applies from the second server start.

**Admin:** None — ETS2 has no RCON, console, or admin concept; the session host moderates in-game. The admin password field is hidden for this game.

## First boot
ETS2 is ATS's twin: the same ich777 SteamCMD wrapper installs the **native Linux** dedicated server (`eurotrucks2_server`, app 1948160, ~12 GB budget — the ETS2 base + map DLC is large) into the save dir `serverfiles/.local/share/Euro Truck Simulator 2`. The image bundles a default `server_packages` world export (base map plus free DLC), so no export from a game client is needed. `server_config.sii` is seeded on the first boot, so **your name, password, and the shifted ports apply from the second start** — restart once; Palisade patches the file before every start thereafter, the same way it does for ATS.

## Gotchas
- **Second-start rule:** lobby name and session password only take effect after one restart — the config file is seeded by the game on the first boot.
- The port block (27018/27019) is intentionally shifted off ATS's defaults so **both truck sims — each ~2 GB RAM — can run at the same time** without tripping the port-conflict guard.
- Want paid map DLCs? Replace `server_packages.sii`/`.dat` in the save dir with an export from your own game client; every joiner must own the same DLCs.
- The true ready line (`[MP] Session running.`) goes to the game's own `server.log.txt`, not stdout — the panel keys on the stdout `[MP] Server init` line, which lands under 2 seconds earlier.
- The connection path rides Steam's relay (SDR virtual ports); the direct connection port mostly matters for LAN play.
