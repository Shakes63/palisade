# Minecraft (Java)

**Image:** `itzg/minecraft-server:latest` (by itzg — the canonical Minecraft image) · **Ports (defaults):** 25565/tcp game (the standard Minecraft port), 25575/tcp RCON (LAN-only, not forwarded)

**Join:** In Minecraft: Multiplayer → Add Server (or Direct Connect) and paste the server IP. The server runs on the default port 25565, so players type just the IP — no port needed. Online, friends use your public IP (forward TCP 25565).

**Admin:** RCON. The password field is labeled "RCON password (enables the console)" — it sets `RCON_PASSWORD` and powers the panel's Console tab, player counts, broadcast, and save-on-stop.

## First boot
Tiny and fast: the image downloads the server jar itself (vanilla/Paper/Forge/Fabric) into `/data`; a vanilla server has booted to Running in ~8.5 s. Ready is detected on the classic `Done (N.NNNs)! For help` line. ~3 GB disk for vanilla; modpacks pull much more. The EULA is accepted automatically (`EULA=TRUE`) by creating the server through the panel. The map field is not a map — it is the world-generation type (`LEVEL_TYPE`): Default, Superflat, Large Biomes, or Amplified. The world folder is always `world`. The JVM heap is sized to ~80% of the server's RAM cap (minimum 1 GB), or 3 GB when no cap is set.

## Gotchas
- CurseForge modpacks: selecting a pack on the Mods tab switches the image to `AUTO_CURSEFORGE` (needs your CurseForge API key); the pack dictates the loader + MC version, so the catalog's TYPE/VERSION settings are suppressed while a pack is set.
- Some packs set `allowModDistribution=false` and cannot be server-installed — itzg fails with "not allowed for project distribution". Palisade checks this at pack-selection time and rejects such packs with a clear message instead of a mysterious Crashed state.
- Real server-grade modpacks (All the Mods etc.) are multi-GB, multi-minute installs — the first modded boot is much slower than vanilla.
- Minecraft is one of only two games (with Valheim) in the mod-updater's scope: modpack updates are detected, badged, and appliable in bulk or on a schedule.
- There is no public server browser and no join-password mechanic — the server name shows as the MOTD in players' lists; access control is the whitelist (add each player's username).
