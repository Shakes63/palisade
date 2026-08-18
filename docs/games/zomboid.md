# Project Zomboid

**Image:** `danixu86/project-zomboid-dedicated-server` (by danixu86; B42 stable, server baked into the image) · **Ports (defaults):** 16261/udp (game + Steam query), 16262/udp (direct connection), 8766/udp + 8767/udp (Steam comms, fixed), 27015/tcp (Source RCON — LAN-only, not forwarded)

**Join:** In Project Zomboid: Join → Favorites — enter the server IP and port 16261 and save it as a favorite. Online, friends use your public IP with the same port. The join password goes in the Server password field on the Join screen.

**Admin:** Source RCON on 27015/tcp (the PZ ini default — the image has no env var to change it). The admin password field is required (min 5 chars): it sets the in-game `admin` account's password on first boot and also gates RCON.

## First boot
Install only pulls the image — the game itself is baked in, so first start is quick. The server is Running at the log line `*** SERVER STARTED ****`. The world is Knox Country (one huge fixed map). Palisade seeds a minimal `servertest.ini` before the first boot (the image applies env by sed-ing that file, which otherwise wouldn't exist yet — passwords and the display name used to silently miss the first session). Sandbox (SandboxVars) tweaks apply from the second start, because the game generates the file from the preset on first boot.

## Gotchas
- Steam Workshop mods work: add them in the Mods tab; Palisade parses the mod's in-game Mod ID from the Workshop description and emits `WORKSHOP_IDS`/`MOD_IDS`. Mods download on the NEXT start after being added.
- The settings catalog covers the full servertest.ini surface (~120 entries) plus ~70 SandboxVars entries. Palisade only writes values you actually changed from the default — untouched keys keep the game's own defaults and in-game admin edits survive restarts.
- "Re-apply preset on start" (SERVERPRESETREPLACE) regenerates SandboxVars and overwrites panel sandbox tweaks by design.
- The internal save name is fixed to `servertest` so the browser-visible display name can change freely; the save directory does not rename with the server.
- There is no max-players env var — MaxPlayers is synced into the ini by Palisade; 32+ players needs serious JVM memory.
- Game updates arrive as new IMAGES, because the server ships inside the image rather than being downloaded by SteamCMD. Every start pulls the image first, so **restarting the server is what moves you onto a newer Project Zomboid build** — there is no separate game download step. Palisade watches the image tag and flags an update (badge + notification) when a newer one is published (GH #26).
- To pin a specific build instead of tracking the newest, set Advanced → image tag to one of the image's versioned tags (e.g. `42.20.3-release`); leave it empty to follow `latest`.
- Ports 8766/8767 (Steam comms) are fixed and player-facing — they must be forwarded along with 16261/16262. Note 8766 collides with Sons of the Forest's game port; the start-time conflict guard stops you running both at once.
