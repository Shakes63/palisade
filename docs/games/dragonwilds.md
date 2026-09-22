# RuneScape: Dragonwilds

**Image:** `ferment9348/dragonwilds` (by blckassassin, from unraid-game-servers; native Linux server via SteamCMD, pinned tag) · **Ports (defaults):** 7777/udp (game) — the only port to forward

**Join:** Three ways, all from Play → Online. PC players can use the **Direct** tab with `<host>:7777` and the world password. Anyone (consoles included) can enter the **invite code** shown on the server's Overview, or search the **Public** tab for the exact **world name** (case-sensitive; the server name only appears as "Created by"). Friends outside your LAN use your public IP. Steam invites do not work for dedicated servers.

**Admin:** No RCON and no admin password — version 1.0 removed it. The admin-password field carries the REQUIRED **Owner Player ID** (32 characters, bottom of the in-game Settings menu). The owner kicks, bans and unbans from the pause menu's Player List; nobody else can.

## First boot
The image pulls the ~5 GB server with SteamCMD on every start (the first pass often fails with "Missing configuration" and retries itself). A world named after the **World name** setting is generated on the first boot, which takes a couple of minutes; the ready marker is the `ReadyToJoin ... value[1]` session line. RAM is roughly 2 GB plus 1 GB per player; the build caps a server at 6 players. World type (Standard, Custom, Creative) is chosen in-client when a world is created, so an auto-generated world is Standard.

## Mods
Nexus Mods only, no workshop. The Linux server loads **pak mods**: a `.pak` with its matching `.utoc` and `.ucas`, uploaded together on the Mods tab into `RSDragonwilds/Content/Paks/~mods`. A `.pak` alone is found but never mounted, and the Mods tab flags it. UE4SS or Lua mods hook the Windows client and cannot run on the server. Server-side paks do not change how the world is listed, and clients without the files still joined in testing, but visual mods must also be installed on every client. Mods are read at startup only.

## Gotchas
- **Stopping never saves.** Only the autosave timer and a player's in-game quit write the save. A stop loses whatever happened since the last autosave, so the **Autosave interval** setting defaults to 5 minutes and can go down to 1.
- **The invite code changes on every restart.** The Overview reads the current one from the log once the server is running.
- **The world name is the save file.** Changing it starts a different world; the old `.sav` stays under `Saved/SaveGames` and comes back when the name is restored. Max 16 characters, case-sensitive in the browser.
- **Consoles lag the Steam build.** After a game patch the server updates on its next start while PlayStation, Xbox and Switch clients wait days for theirs; a patched server cannot be joined by an unpatched client. Hold off restarting the server until console players have the update.
- **The game logs the world password** in plain text at boot and base64-encoded on every login line. Treat the Logs tab accordingly.
- **The beacon port (8888) and LAN discovery (45453) are not published.** Joins work without them; LAN discovery is broadcast-based and cannot work through a Docker bridge, so use the Direct tab on a LAN.
- **Crossplay is on by default.** To restrict platforms, edit `PlatformPolicy` (`Crossplay`, `PC`, `PlayStation`, `Xbox`, `Nintendo`) in `RSDragonwilds/Saved/Config/LinuxServer/DedicatedServer.ini` while the server is stopped; the panel leaves that key alone.
