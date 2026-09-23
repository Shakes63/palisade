# ARK: Survival Evolved

**Image:** `hermsi/ark-server:latest` (by Hermsi — arkmanager-based, native Linux ShooterGameServer) · **Ports (defaults):** 7777/udp game, 7778/udp raw socket, 27015/udp query (server browser), 27020/tcp RCON (LAN-only, not forwarded)

**Join:** Over LAN, open the ARK console (`~`), paste `open <ip>:7777` and press Enter. With a join password set the console command will not work (ARK cannot pass a password through the console), so find the server on the Unofficial list (Show Player Servers ON, PC-Only Online Multiplayer OFF, Show Password Protected Servers ON) and paste the password when prompted.

**Admin:** RCON. The admin password field is the server admin password and enables RCON; the panel's Console tab and player counts use it.

## First boot
~12 GB install. The image installs the game files and any Steam Workshop mods itself on first boot (`UPDATE_ON_START=true`), into `<volume>/server`, and updates them on every subsequent start. Palisade renders the config INIs into `server/ShooterGame/Saved/Config/LinuxServer` before each start. Ready is detected on arkmanager's stdout line "server is up" (ASE's own "advertising" line goes to a file inside the container, not docker logs). 12 official maps selectable, The Island through Fjordur.

## Gotchas
- On a 32 GB box, run ONE ARK server at a time — an ASA + ASE pair running together has OOM'd the host. Keep the RAM cap set (~8 GB for ASE); a populated server wants ~7 GB.
- Mods are Steam Workshop (consumer app id 346110) — the Mods tab browses/installs Workshop items and arkmanager downloads them on start. First boot with mods is slow (Workshop download + extraction).
- Workshop-list mods are redownloaded every start, so "mod update" is just a restart — ASE is deliberately not in the mod-updater's scope.
- Cluster transfers are wired the same way as ASA (`-clusterid` + `-ClusterDirOverride` via arkmanager `--arkopt` args) but have not been boot-validated live.
- BattlEye can be disabled per server (`DISABLE_BATTLEYE=true`).
