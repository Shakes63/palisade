# Minecraft (Bedrock)

**Image:** `itzg/minecraft-bedrock-server:latest` (by itzg — downloads Mojang's native Bedrock server on boot) · **Ports (defaults):** 19132/udp game (IPv4), 19133/udp game (IPv6)

**Join:** In Minecraft Bedrock: Play → Servers → Add Server — address = the server IP, port = 19132. Works from phones, consoles, and Win10/11. Online, friends use your public IP (forward UDP 19132).

**Admin:** None — Bedrock has no RCON; the console is stdin-only, so the panel hides the Console tab and there is no admin password field. Save-on-stop and broadcast are no-ops. Access control is the allow-list (add each player's gamertag).

## First boot
Small and quick: the image is ~191 MB, there is no SteamCMD/Wine, and a fresh server has reached Running in ~12 s. Ready is detected on the log line `Server started.` Budget ~2 GB disk and ~1–2 GB RAM even populated. The map field is the world-generation type (`LEVEL_TYPE`): DEFAULT, FLAT, or LEGACY (small finite world). The world folder is always `world`, under `/data/worlds`.

## Gotchas
- Permissions: unlike the Java image, the Bedrock image does NOT chown `/data` itself — it drops to its UID/GID and immediately writes, which crashed on a fresh root-owned instance dir ("mkdir: cannot create directory '/data/.tmp': Permission denied"). Palisade now chowns the instance root to the runtime user before every Bedrock start, so this is handled — but don't hand-create instance dirs as root.
- No RCON also means no live console and no remote commands — anything interactive needs `docker attach`/`send-command` on the container.
- "Mods" here are add-ons (behavior/resource packs), not Java mods: upload a `.mcpack`/`.mcaddon` on the Mods tab and Palisade unzips it, parses each manifest, copies it to `behavior_packs`/`resource_packs`, and activates it in the world's `world_behavior_packs.json`/`world_resource_packs.json`. Removing a pack de-registers it.
- There is no public server browser — players add the server by IP; the server name appears in their saved list.
