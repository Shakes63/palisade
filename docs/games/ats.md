# American Truck Simulator

**Image:** `ghcr.io/ich777/steamcmd:ats` (by ich777) · **Ports (defaults):** 27015/udp (connection), 27016/udp (Steam query / session search)

**Join:** In American Truck Simulator, open **Convoy → search sessions** and find the server by name (up to 8 players — SCS's hard Convoy cap). Everyone joining needs the **same map DLCs** as the server's world export. Enter the session password if one is set — it applies from the second server start.

**Admin:** None — ATS has no RCON, console, or admin concept; the session host moderates in-game. The admin password field is hidden for this game.

## First boot
SteamCMD installs the **native Linux** dedicated server (`amtrucks_server`, app 2239530, ~10 GB budget with the map DLC most servers run). The image bundles a default `server_packages` world export (base map plus the free Arizona/Nevada DLCs), sidestepping ATS's notorious requirement to export one from a game client. `server_config.sii` is seeded into the save dir on that first boot, so **your name, password, and ports apply from the second start** — restart once after the initial boot; Palisade patches the file before every start thereafter.

## Gotchas
- **Second-start rule:** the config file can't be pre-written (the game seeds it on first boot), so the lobby name and session password only take effect after one restart.
- Want paid map DLCs? Replace `server_packages.sii`/`.dat` in the save dir (`serverfiles/.local/share/American Truck Simulator`) with an export from your own game client — and every joiner must own the same DLCs.
- The true ready line (`[MP] Session running.`) goes to the game's own `server.log.txt`, not stdout — the panel keys on the stdout `[MP] Server init` line, which lands under 2 seconds earlier.
- Only 27016/udp visibly binds; the connection path rides Steam's relay (SDR virtual ports), so the direct 27015 port mostly matters for LAN play.
- 27015 overlaps Icarus's query port, Project Zomboid's RCON, and Factorio's RCON — the start-time conflict guard prevents running those alongside ATS.
- The game rewrites `server_config.sii` on boot and may unquote simple tokens — harmless; the patcher handles it.
- The server is tiny — well under 2 GB RAM even with a full 8-player convoy, so it pairs fine with a running ETS2 server.
