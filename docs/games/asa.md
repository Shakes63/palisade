# ARK: Survival Ascended

**Image:** `acekorneya/asa_server:2_1_latest` (the POK image by acekorneya — SteamCMD + Proton internally) · **Ports (defaults):** 7777/udp game, 7778/udp raw socket, 27015/udp query (server browser), 27020/tcp RCON (LAN-only, not forwarded)

**Join:** Over LAN, open the ARK console (`~`), paste `open <ip>:7777` and press Enter. If the server has a join password this does not work — ARK's console cannot pass a password (it always rejects with "invalid server password") — so instead find the server on Join ARK → Unofficial (Show Player Servers ON, PC-Only Online Multiplayer OFF, Show Password Protected Servers ON) and enter the password at the prompt.

**Admin:** RCON. The admin password field is the ARK server admin password and enables RCON (`RCON_ENABLED=TRUE`); the panel's Console tab authenticates with it. Player counts also come over RCON.

## First boot
- Big: ~13 GB depot (15 GB disk preflight), and plan on ~16 GB RAM for a populated server — by far the heaviest game in the panel. The image installs/updates the game files itself on every start (`UPDATE_SERVER=TRUE`).
- Ready is detected on the log line "Server has completed startup and is now advertising for join" — the earlier "has successfully started!" and "Full Startup: N seconds" lines fire ~30 s before the server actually takes joins.
- 11 official maps are selectable (The Island through Lost Colony and Genesis: Part 1, plus Club ARK); mod maps are added dynamically.

## Gotchas
- On a 32 GB box, run ONE ARK server at a time — two at once (ASA + ASE) has OOM'd the host into a swap thrash. Keep the per-server RAM cap set (~14 GB for ASA).
- Mods are CurseForge, not Steam Workshop (ASA has no Workshop app id) — the Mods tab browses CurseForge with your API key.
- Cluster transfers: the POK image sets `-clusterid` but never `-ClusterDirOverride`, so Palisade appends the override itself to point all cluster members at the shared transfer dir.
- The MOTD must flow through the panel: POK rewrites the `[MessageOfTheDay]` INI section from env vars on every launch, stripping anything written to the file directly.
- BattlEye can be toggled off per server (`BATTLEYE=FALSE`).
- ASA wants a high file-descriptor limit; the container is started with `nofile` 100000 because the image cannot raise it itself.
