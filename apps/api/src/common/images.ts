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
  // trueosiris/vrising — installs the V Rising Windows server via SteamCMD and runs
  // it under Wine. Settings via generic HOST_SETTINGS_*/GAME_SETTINGS_* env vars
  // that patch the two settings JSONs. Source RCON (we enable it via env).
  [Game.VRISING]: "trueosiris/vrising:latest",
  // jammsen — installs the SotF Windows server (app 2465200) via SteamCMD on boot and
  // runs it under Wine as a non-root steam user (PUID/PGID). We render
  // userdata/dedicatedserver.cfg (the init script only seeds it when missing). NO RCON.
  [Game.SOTF]: "jammsen/sons-of-the-forest-dedicated-server:latest",
  // wolveix — installs the native Linux Satisfactory server (app 1690800) via
  // SteamCMD on boot into /config/gamefiles. Env-driven. No RCON — management is
  // the game's own HTTPS API on the game port (see satisfactory-api.ts).
  [Game.SATISFACTORY]: "wolveix/satisfactory-server:latest",
  // ich777's SteamCMD wrapper, lifyo flavour — installs the LiF:YO Windows server
  // (app 320850) via SteamCMD on boot, runs it under Wine, and bundles the game's
  // required MariaDB IN the container (datadir persisted under the serverfiles
  // bind). Settings live in config/world_1.xml, which the manager patches. NO RCON.
  [Game.LIF]: "ghcr.io/ich777/steamcmd:lifyo",
  // ich777's SteamCMD wrapper, ats flavour — installs the NATIVE Linux ATS dedicated
  // server (app 2239530) on boot and seeds a default server_packages world template
  // (normally exported from a game client) + server_config.sii into the save dir on
  // first boot. The manager patches server_config.sii before later starts. NO RCON.
  [Game.ATS]: "ghcr.io/ich777/steamcmd:ats",
  // Same wrapper, ETS2 flavour — identical contract to ATS (app 1948160, save dir
  // "Euro Truck Simulator 2", native eurotrucks2_server binary).
  [Game.ETS2]: "ghcr.io/ich777/steamcmd:ets2",
  // escaping/core-keeper-dedicated — installs the native Linux Core Keeper server
  // (app 1963720) via SteamCMD on boot. Env-driven. DEFAULT NETWORK MODE IS STEAM
  // RELAY: no ports at all — players join with the Game ID token the server writes
  // to GameID.txt in the server-files bind. NO RCON.
  [Game.CORE_KEEPER]: "escaping/core-keeper-dedicated:latest",
  // ryshe/terraria — TShock (server + admin plugin framework) baked into the image;
  // nothing to download on boot. TShock's config.json lives IN the worlds volume
  // (CONFIGPATH), rendered by the manager; its REST API (7878) powers player
  // counts. Console is stdin-only (hidden); world args pass through the entrypoint.
  [Game.TERRARIA]: "ryshe/terraria:latest",
  // factoriotools/factorio — the canonical Factorio image; the headless server is
  // baked in (stable tag). One /factorio volume (saves/config/mods). PUID/PGID
  // supported natively; RCON password comes from config/rconpw; server-settings
  // .json is merge-patched by the manager. Full Source RCON console.
  [Game.FACTORIO]: "factoriotools/factorio:stable",
  // didstopia/rust-server — installs/updates the Rust dedicated server (app 258550,
  // ~12 GB) via SteamCMD on boot into the /steamcmd/rust bind. Env-driven; we run
  // RCON in LEGACY Source mode (RUST_RCON_WEB=0) so the existing RCON stack works.
  // Optional Oxide/uMod via env toggle.
  [Game.RUST]: "didstopia/rust-server:latest",
  // rouhim/beammp-server — the BeamMP (BeamNG.drive multiplayer) server, baked into
  // the image. Fully env-driven; REQUIRES a free beammp.com AuthKey (carried in the
  // admin-password field). The server is a lightweight relay — physics run on the
  // clients. NO RCON/query; console is stdin-only.
  [Game.BEAMMP]: "rouhim/beammp-server:latest",
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

/** V Rising (trueosiris) splits data: the SteamCMD game install vs the world saves +
 *  settings JSONs. Bound separately so backups target the small persistentdata dir. */
export const VRISING_SERVER_DIR = "/mnt/vrising/server";
export const VRISING_DATA_DIR = "/mnt/vrising/persistentdata";

/** Sons of the Forest (jammsen): ONE volume holds the ~10 GB game install AND the
 *  userdata (config + saves) at <vol>/userdata — backups target just userdata. */
export const SOTF_GAME_DIR = "/sonsoftheforest";

/** Satisfactory (wolveix): ONE /config volume holds gamefiles (~10 GB install),
 *  saved (saves + blueprints + server config), backups, and logs. */
export const SATISFACTORY_CONFIG_DIR = "/config";

/** LiF:YO (ich777): SteamCMD itself + the serverfiles (game install, world_1.xml
 *  config, logs, AND the bundled MariaDB datadir at .database/). */
export const LIF_STEAMCMD_DIR = "/serverdata/steamcmd";
export const LIF_SERVERFILES_DIR = "/serverdata/serverfiles";

/** ATS/ETS2 (ich777, same wrapper layout as LiF): SteamCMD + serverfiles. The config +
 *  server_packages + saves live under the game's XDG data dir inside serverfiles. */
export const ATS_SAVE_SUBDIR = ".local/share/American Truck Simulator";
export const ETS2_SAVE_SUBDIR = ".local/share/Euro Truck Simulator 2";

/** Core Keeper (escaping): the game install + GameID.txt vs the world saves. */
export const CORE_KEEPER_FILES_DIR = "/home/steam/core-keeper-dedicated";
export const CORE_KEEPER_DATA_DIR = "/home/steam/core-keeper-data";

/** Terraria (ryshe/TShock): worlds + TShock config.json share one volume
 *  (CONFIGPATH points there); plugins + logs are separate volumes. */
export const TERRARIA_WORLDS_DIR = "/root/.local/share/Terraria/Worlds";
export const TERRARIA_PLUGINS_DIR = "/tshock/ServerPlugins";
export const TERRARIA_LOGS_DIR = "/tshock/logs";

/** Factorio (factoriotools): one volume holds saves/, config/, mods/, scenarios/. */
export const FACTORIO_DATA_DIR = "/factorio";

/** Rust (didstopia): one volume holds the ~12 GB install AND the server identity
 *  (saves/cfg under server/docker) — backups target just the identity dir. */
export const RUST_DATA_DIR = "/steamcmd/rust";

/** BeamMP (rouhim): client-mod zips (maps/vehicles sent to joiners) + server-side
 *  Lua plugins. There's no world state — these ARE the persistent data. */
export const BEAMMP_CLIENT_MODS_DIR = "/beammp/Resources/Client";
export const BEAMMP_SERVER_MODS_DIR = "/beammp/Resources/Server";

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
  [Game.VRISING]: 0, // trueosiris runs as root (no PUID/PGID support)
  [Game.SOTF]: 1000, // jammsen's steam user, remapped to env PUID/PGID (entrypoint chowns)
  [Game.SATISFACTORY]: 1000, // wolveix runs the game as PUID/PGID (default 1000)
  [Game.LIF]: 99, // ich777's default nobody/users, remapped via UID/GID env (we pass PUID/PGID)
  [Game.ATS]: 99, // same ich777 wrapper convention
  [Game.ETS2]: 99,
  [Game.CORE_KEEPER]: 1000, // escaping's steam user, remapped via PUID/PGID (we pass ours)
  [Game.TERRARIA]: 0, // the ryshe image runs as root
  [Game.FACTORIO]: 845, // the image's "factorio" user, remapped via PUID/PGID (we pass ours)
  [Game.RUST]: 0, // didstopia runs as root
  [Game.BEAMMP]: 0, // rouhim runs as root (mod dirs world-writable per its docs)
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
  [Game.VRISING]: 0,
  [Game.SOTF]: 1000,
  [Game.SATISFACTORY]: 1000,
  [Game.LIF]: 100,
  [Game.ATS]: 100,
  [Game.ETS2]: 100,
  [Game.CORE_KEEPER]: 1000,
  [Game.TERRARIA]: 0,
  [Game.FACTORIO]: 845,
  [Game.RUST]: 0,
  [Game.BEAMMP]: 0,
};
