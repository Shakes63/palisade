# Palworld (Wine — full mods)

**Image:** `ghcr.io/ripps818/docker-palworld-dedicated-server-wine` (by ripps818, a jammsen fork; Windows PalServer.exe under Wine + Xvfb) · **Ports (defaults):** 8211/udp (game — fixed by the image, see below), 8314/tcp (RCON — LAN-only, not forwarded)

**Join:** Same as native Palworld: Join Multiplayer Game (Dedicated) → Connect with IP, paste the server IP and port 8211. Online, friends use your public IP with the same port. Enter the join password when prompted.

**Admin:** Source RCON on 8314/tcp — the admin password field enables RCON and is the RCON password. The image deprecated its own RCON tooling in favor of a REST API, but ini-level RCON still works; Palisade uses it (`ShowPlayers`) for player counts.

## First boot
This variant exists to run the Windows binary, which is what unlocks DLL mods (PalGuard, PalDefender) the native Linux server can't load. The image is large (~3.3 GB) and the ~6 GB game depot downloads via SteamCMD on the first start. Its RCON/query slots are shifted (8312-8314) so it can be installed alongside a native Palworld server, but the game port cannot move (below). Expect roughly 10 GB RAM budget; idle sits around 1.5 GiB.

## PalSchema (JSON content mods)

PalSchema is a UE4SS logic mod that loads JSON-defined content (new Pals, items,
recipes) without anyone writing a Blueprint mod. It is a Windows DLL loaded by UE4SS
itself, so it runs on this variant only, and it needs UE4SS installed first. The Mods
tab refuses every PalSchema write until both conditions hold, rather than only greying
out the buttons, so a stale tab or a direct API call cannot slip past it.

- **Install** with the one-click button (pinned release, checksum-verified) or by
  uploading a PalSchema release zip. Either way it lands in
  `Pal/Binaries/Win64/Mods/PalSchema`.
- **UE4SS starts a DLL mod from an `enabled.txt` marker in the mod's own folder**, not
  from `Mods/mods.txt`. That file is the separate Lua-mod enable list (`Name : 1`), and
  adding a PalSchema entry to it does nothing. The release zip ships the marker; the
  panel warns if a hand-built archive left it out.
- Reinstalling UE4SS over an existing install keeps your `Mods/mods.txt`. UE4SS's
  archive ships its own copy, which would otherwise re-enable the mods you disabled
  (PalSchema's install notes have you turn off CheatManagerEnablerMod and
  ConsoleCommandsMod to avoid crashes).

### Content mods

Upload a content mod's own `.zip`. Authors package these at wildly different depths,
so Palisade finds the mod folder rather than assuming a layout: it looks for the
`PalSchema/mods/<ModName>` marker anywhere in the archive and takes what is under it,
whether the zip is a bare `ModName/` folder, a partial `Mods/PalSchema/mods/...` path,
or a full `Pal/Binaries/Win64/ue4ss/Mods/PalSchema/mods/...` tree. (That last shape is
why the prefix cannot be hardcoded: some authors package for UE4SS's newer `ue4ss/Mods`
layout while this server uses `Win64/Mods`.) The folder ends up at
`Pal/Binaries/Win64/Mods/PalSchema/mods/<ModName>` either way, with every file it
shipped, and an archive carrying no JSON is rejected instead of silently installing
nothing.

The gear beside a mod opens its `.json`/`.jsonc` files in an editor. Edits save straight
to the mod folder, and the server has to restart to pick them up. These are `.jsonc`
files, so comments and trailing commas are allowed and the content is not validated as
strict JSON. Editing needs the operator role, the same as the Files tab.

**Re-uploading a mod replaces its folder wholesale**, so any config you edited in place
is lost. Keep a copy of the edited file if you are updating a mod you have tuned.

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
