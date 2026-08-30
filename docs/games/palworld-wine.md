# Palworld (Wine — full mods)

**Image:** `ghcr.io/ripps818/docker-palworld-dedicated-server-wine` (by ripps818, a jammsen fork; Windows PalServer.exe under Wine + Xvfb) · **Ports (defaults):** 8211/udp (game — fixed by the image, see below), 8314/tcp (RCON — LAN-only, not forwarded)

**Join:** Same as native Palworld: Join Multiplayer Game (Dedicated) → Connect with IP, paste the server IP and port 8211. Online, friends use your public IP with the same port. Enter the join password when prompted.

**Admin:** Source RCON on 8314/tcp — the admin password field enables RCON and is the RCON password. The image deprecated its own RCON tooling in favor of a REST API, but ini-level RCON still works; Palisade uses it (`ShowPlayers`) for player counts.

## First boot
This variant exists to run the Windows binary, which is what unlocks DLL mods (PalGuard, PalDefender) the native Linux server can't load. The image is large (~3.3 GB) and the ~6 GB game depot downloads via SteamCMD on the first start. Its RCON/query slots are shifted (8312-8314) so it can be installed alongside a native Palworld server, but the game port cannot move (below). Expect roughly 10 GB RAM budget; idle sits around 1.5 GiB.

## Gotchas
- The image emits NO positive ready log line — Palisade's marker is `>>> Starting the gameserver`, printed just before the Wine launch, so the flip to Running is 1-2 minutes early. RCON and player-count polls retry until the server actually binds; that early window is normal.
- **The game port is fixed at 8211.** The image launches `PalServer.exe` with no
  `-port=` argument and provides no way to pass one, so the server always binds
  Palworld's default. `PUBLIC_PORT` only writes `PublicPort=` into the ini, which is
  the port *advertised* to the community list — not the one bound (GH #39). On the
  shared bridge you can still pick any host port and Docker remaps it onto 8211; on
  host networking there is no remapping, so the port must stay 8211 and Palisade
  refuses the start rather than report an address that will not answer.
- `SERVER_SETTINGS_MODE=auto` is required (Palisade sets it). The image defaults to `manual`, which silently discards every env var — the server would boot on its hard-coded defaults (port 8211, RCON off). Verify applied settings in `Pal/Saved/Config/WindowsServer/PalWorldSettings.ini`.
- Wine only loads a mod's proxy DLL if `WINEDLLOVERRIDES` names it — Palisade handles this. `dwmapi=n,b` (UE4SS) is always set, and at each start Palisade scans `Pal/Binaries/Win64` for other known proxy loaders (`d3d9.dll` — PalDefender 1.5.2+, `version`, `winmm`, `dxgi`, …) and adds overrides for the ones present. So after dropping in a proxy-based mod, just restart the server. Safe when no proxy is on disk (`n,b` falls back to Wine's builtin).
- The one-click UE4SS install uses the official Windows build (v3.0.1, pinned) into `Pal/Binaries/Win64`; DLL mods drop into `Pal/Binaries/Win64/Mods`. No launcher patch is needed on this variant.
- Game updates only happen when the image runs SteamCMD on start (`ALWAYS_UPDATE_ON_START`, from the settings catalog) — Palisade's Install/Update alone only pulls the image.
- Its env contract differs from the native image (MAX_PLAYERS vs PLAYERS, lowercase booleans) — it is a separate game entry, not a toggle on the native one. Note `PUBLIC_PORT` is *not* the equivalent of the native image's `PORT`: it advertises, it does not bind.
