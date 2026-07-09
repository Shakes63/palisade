import { Game } from "@ark/shared";

/**
 * Game-server images. Both are proven, env-var-driven images that install the
 * game files + mods themselves on first boot and read our injected INIs — the
 * manager orchestrates them via env vars + config injection rather than passing
 * a launch command (validated on a real Unraid host, PLANNING.md).
 * - ASA: the POK image (acekorneya/asa_server) — SteamCMD + Proton internally.
 * - ASE: hermsi/ark-server (arkmanager-based) — native Linux ShooterGameServer.
 */
export const IMAGES: Record<Game, string> = {
  [Game.ASA]: "acekorneya/asa_server:2_1_latest",
  [Game.ASE]: "hermsi/ark-server:latest",
  // POK family (same author as ASA): native Linux Conan Enhanced server. Installs
  // app 443030 via SteamCMD on boot; writes its own INIs from env vars.
  [Game.CONAN]: "acekorneya/conan_enhanced_server:latest",
  // thijsvanloef/palworld-server-docker — env-driven; installs app 2394010 via
  // SteamCMD on boot, compiles PalWorldSettings.ini from env, has RCON.
  [Game.PALWORLD]: "thijsvanloef/palworld-server-docker:latest",
  // itzg/minecraft-server — the canonical Minecraft image. Downloads the server
  // jar (vanilla/Paper/Forge/Fabric) itself on first boot into /data, writes
  // server.properties from env vars, and has built-in RCON.
  [Game.MINECRAFT]: "itzg/minecraft-server:latest",
  // mornedhels/icarus-server — installs the Icarus Windows server via SteamCMD and
  // runs it under Wine. Env-driven (writes ServerSettings.ini itself). No RCON.
  [Game.ICARUS]: "mornedhels/icarus-server:latest",
  // itzg/minecraft-bedrock-server — downloads Mojang's Bedrock server on boot, writes
  // server.properties from env. UDP (19132/19133). No RCON (console via stdin only).
  [Game.BEDROCK]: "itzg/minecraft-bedrock-server:latest",
  // lloesche/valheim-server — installs the native Linux Valheim server via SteamCMD on
  // boot; env-driven (SERVER_NAME/WORLD_NAME/SERVER_PASS…). UDP (2456/2457). No RCON.
  [Game.VALHEIM]: "lloesche/valheim-server:latest",
  // vinanrra/7dtd-server — LinuxGSM-wrapped 7 Days to Die server. Installs via SteamCMD
  // on boot; the game settings live in sdtdserver.xml (we render it). Telnet console.
  [Game.SEVEN_DAYS]: "vinanrra/7dtd-server:latest",
  // mornedhels/enshrouded-server — installs the Enshrouded Windows server via SteamCMD
  // and runs it under Proton (same family as Icarus). Env-driven. UDP. No RCON.
  [Game.ENSHROUDED]: "mornedhels/enshrouded-server:latest",
  // danixu86 — Project Zomboid B41 stable (the server binary is baked into the
  // image; only the Zomboid data dir persists). Env-driven; Source RCON; Workshop
  // mods via WORKSHOP_IDS + MOD_IDS. B42 = the :latest-unstable tag when it lands.
  [Game.ZOMBOID]: "danixu86/project-zomboid-dedicated-server:latest",
};

/** POK keeps all instance data (install + saves + config) under this path. */
export const POK_DATA_DIR = "/home/pok/arkserver";

/** hermsi's ARK_SERVER_VOLUME — game files install under <vol>/server. */
export const HERMSI_VOLUME = "/app";

/** Conan image's data base — it expects /data/server, /data/steam, /data/backups,
 *  so we bind the whole instance dir here. Saves live at server/ConanSandbox/Saved. */
export const CONAN_DATA_DIR = "/data";

/** Palworld image installs the game + saves under /palworld (saves at Pal/Saved). */
export const PALWORLD_DATA_DIR = "/palworld";

/** itzg/minecraft-server keeps the jar + worlds + config under /data (world at /data/world). */
export const MINECRAFT_DATA_DIR = "/data";

/** Icarus (mornedhels) splits its data: config + saves (prospects) under the Wine
 *  drive, the ~15 GB game files under /opt/icarus. Bound separately so backups /
 *  disk stats can target the small config+saves dir, not the big game install. */
export const ICARUS_CONFIG_DIR = "/home/icarus/drive_c/icarus"; // ServerSettings.ini + Saved/prospects
export const ICARUS_GAME_DIR = "/opt/icarus"; // SteamCMD-installed game files

/** itzg bedrock keeps the server + config + worlds under /data (worlds at /data/worlds). */
export const BEDROCK_DATA_DIR = "/data";

/** Valheim (lloesche) splits data: config + worlds under /config (worlds at
 *  /config/worlds_local), server files under /opt/valheim. Bound separately so
 *  backups target the small worlds dir, not the game install. */
export const VALHEIM_CONFIG_DIR = "/config";
export const VALHEIM_GAME_DIR = "/opt/valheim";

/** 7 Days to Die (vinanrra/LinuxGSM): the game install + sdtdserver.xml live under
 *  serverfiles/; the world/player saves live under the user's .local/share. Bound
 *  separately so backups target the small saves dir, not the ~20 GB install. */
export const SEVEN_DAYS_SERVERFILES_DIR = "/home/sdtdserver/serverfiles";
export const SEVEN_DAYS_SAVES_DIR = "/home/sdtdserver/.local/share/7DaysToDie";

/** Enshrouded (mornedhels): the image installs the game under /opt/enshrouded/server,
 *  so the config (enshrouded_server.json) + the savegame dir live at
 *  /opt/enshrouded/server/{enshrouded_server.json,savegame}. We bind the whole
 *  /opt/enshrouded dir; backups target just the server/savegame subpath. */
export const ENSHROUDED_GAME_DIR = "/opt/enshrouded";

/** Project Zomboid keeps ALL its persistent data (saves, server configs, player db)
 *  under the Zomboid home dir; the game install itself is baked into the image. */
export const ZOMBOID_DATA_DIR = "/home/steam/Zomboid";

/**
 * The uid/gid each image runs the server as. Neither chowns its mounts fully
 * (POK never does; hermsi only chowns the volume root), so the manager makes the
 * dirs/files it injects (config INIs, cluster transfer dir) writable by these.
 */
export const SERVER_UID: Record<Game, number> = {
  [Game.ASA]: 7777, // POK's fixed "pok" user (also in group 100/users)
  [Game.ASE]: 1000, // hermsi's "steam" user
  [Game.CONAN]: 1000, // Conan image's "pokuser"
  [Game.PALWORLD]: 1000, // palworld image's "steam" user
  [Game.MINECRAFT]: 1000, // itzg's default UID (overridable via UID/GID env)
  [Game.ICARUS]: 4711, // mornedhels default (overridable via PUID/PGID); unused — env-driven, no INI injection
  [Game.BEDROCK]: 1000, // itzg derives UID/GID from /data owner; we pass PUID/PGID. Unused here.
  [Game.VALHEIM]: 0, // lloesche runs as root by default (we don't override PUID/PGID)
  [Game.SEVEN_DAYS]: 1000, // LinuxGSM's sdtdserver user; we pass env.PUID/PGID + chown
  [Game.ENSHROUDED]: 4711, // mornedhels default (overridable via PUID/PGID); env-driven, no INI injection
  [Game.ZOMBOID]: 1000, // danixu86 runs as the "steam" user
};
export const SERVER_GID: Record<Game, number> = {
  [Game.ASA]: 7777,
  [Game.ASE]: 1000,
  [Game.CONAN]: 1000,
  [Game.PALWORLD]: 1000,
  [Game.MINECRAFT]: 1000,
  [Game.ICARUS]: 4711,
  [Game.BEDROCK]: 1000,
  [Game.VALHEIM]: 0,
  [Game.SEVEN_DAYS]: 1000,
  [Game.ENSHROUDED]: 4711,
  [Game.ZOMBOID]: 1000,
};
