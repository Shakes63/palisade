# Life is Feudal: Your Own

**Image:** `ghcr.io/ich777/steamcmd:lifyo` (by ich777) · **Ports (defaults):** 28000–28003, each published on both TCP and UDP — 28000 game, 28001 game+1, 28002 Steam query (A2S), 28003 mapped by the ich777 template convention

**Join:** In Life is Feudal: Your Own, open **Multiplayer** and search the server list by name, or use **Connect to custom IP** with the server address and port 28000. Enter the join password if one is set — but note it only applies from the second start (see below).

**Admin:** No RCON or remote console. The admin password field sets the in-game **GM password** (`adminPassword` in `world_1.xml`) — log in with it in-game to unlock GM mode.

## First boot
SteamCMD installs the Windows server (app 320850, ~8 GB budget) and runs it under Wine; the image also bundles the game's required **MariaDB inside the container** (datadir persisted at `serverfiles/.database`). The first boot does Wine setup, the DB schema import, and world/navmesh generation — around 10 minutes total, with long stretches of `NavMesh updating: N tiles left` that are normal. Because SteamCMD writes `config/world_1.xml` during that first install, the first boot runs with the image defaults ("LiF Docker"); **restart once after the first boot** and Palisade applies your name, passwords, and settings from then on.

## Gotchas
- **Name, join password, and GM password apply from the second start.** The config file doesn't exist until the first install finishes, so the panel patches it before every start once present — one restart after first boot fixes everything.
- Backups of a **running** server include the live MariaDB datadir and are crash-consistent only — prefer backing up while stopped for a clean snapshot.
- The boot error `cannot change namespace parent linkage of WeaponImage from WeaponData to ShieldData` is non-fatal — ignore it.
- The wrapper prints `---Server ready---` **before** the Wine launch; the real joinable marker (which the panel uses) is the game's own `Server is up and ready to accept connections`.
- A2S answers on 28002 with the correct name and player count out of the box — no listing toggle needed.
- Max players is a hard 1–64 range enforced by `world_1.xml`.
