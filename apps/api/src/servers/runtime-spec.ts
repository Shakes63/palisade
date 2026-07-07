import type Docker from "dockerode";
import {
  Game,
  GAME_ICONS,
  SettingTarget,
  type PortSet,
  type ServerConfigValues,
  type SettingsCatalog,
  type MotdValue,
} from "@ark/shared";
import { buildCustomArgs, isBattlEyeDisabled } from "../catalog/command-line";
import { HostPaths, ContainerPaths } from "../common/paths";
import {
  IMAGES,
  POK_DATA_DIR,
  HERMSI_VOLUME,
  CONAN_DATA_DIR,
  PALWORLD_DATA_DIR,
  MINECRAFT_DATA_DIR,
  ICARUS_CONFIG_DIR,
  ICARUS_GAME_DIR,
  BEDROCK_DATA_DIR,
  VALHEIM_CONFIG_DIR,
  VALHEIM_GAME_DIR,
  SEVEN_DAYS_SERVERFILES_DIR,
  SEVEN_DAYS_SAVES_DIR,
  ENSHROUDED_GAME_DIR,
} from "../common/images";
import { ARK_NETWORK, containerName } from "../common/naming";
import { loadEnv } from "../config/env";

export interface RuntimeSpecInput {
  serverId: string;
  game: Game;
  map: string;
  sessionName: string;
  ports: PortSet;
  maxPlayers: number;
  adminPassword: string;
  serverPassword?: string | null;
  spectatorPassword?: string | null;
  modIds: number[];
  cluster?: { clusterId: string } | null;
  config: ServerConfigValues;
  catalog: SettingsCatalog;
  ramLimitMb?: number | null;
  cpuLimit?: number | null;
  /** IANA timezone for the game container clock; falls back to the manager's TZ. */
  timezone?: string | null;
  /** CurseForge API key (Minecraft only) — lets itzg auto-install a modpack. */
  curseForgeApiKey?: string | null;
}

/** Build the Docker create spec for a game-server container. */
export function buildContainerSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  if (input.game === Game.ASA) return buildPokSpec(input);
  if (input.game === Game.CONAN) return buildConanSpec(input);
  if (input.game === Game.PALWORLD) return buildPalworldSpec(input);
  if (input.game === Game.MINECRAFT) return buildMinecraftSpec(input);
  if (input.game === Game.ICARUS) return buildIcarusSpec(input);
  if (input.game === Game.BEDROCK) return buildBedrockSpec(input);
  if (input.game === Game.VALHEIM) return buildValheimSpec(input);
  if (input.game === Game.SEVEN_DAYS) return buildSevenDaysSpec(input);
  if (input.game === Game.ENSHROUDED) return buildEnshroudedSpec(input);
  return buildAseSpec(input);
}

const portKey = (p: number, proto: "udp" | "tcp") => `${p}/${proto}`;

/**
 * Container labels. Besides our own ark.* labels, we set Unraid's per-container
 * icon (the game's badge) and a WebUI deep-link back to the manager's page for
 * this server, so each spawned server looks right on the Unraid Docker dashboard.
 */
function serverLabels(input: RuntimeSpecInput, baseUrl: string): Record<string, string> {
  return {
    "ark.role": "server",
    "ark.serverId": input.serverId,
    "ark.game": input.game,
    "net.unraid.docker.icon": GAME_ICONS[input.game],
    "net.unraid.docker.webui": `${baseUrl}/servers/${input.serverId}`,
  };
}

/**
 * The server join password. Primary source is the plain-text catalog setting
 * (config.values.ServerPassword) so it's visible/editable in the UI; falls back
 * to the legacy encrypted value (input.serverPassword) for older servers.
 */
function serverPassword(input: RuntimeSpecInput): string {
  const v = input.config.values?.["ServerPassword"];
  if (typeof v === "string" && v.trim()) return v;
  return input.serverPassword ?? "";
}

/** Pull the MOTD widget value out of the config (POK manages it via env vars). */
function readMotd(config: ServerConfigValues): MotdValue | null {
  const v = config.values?.["MessageOfTheDay"] as Partial<MotdValue> | undefined;
  if (!v || typeof v.message !== "string") return null;
  return { message: v.message, duration: Number(v.duration) || 20 };
}

/**
 * ASA: drive the proven POK image (acekorneya/asa_server) via env vars. POK runs
 * SteamCMD + Proton internally and builds the launch line from these vars; the
 * manager renders the INIs into the mounted config dir and reads RCON over the
 * shared network. (Verified on a real Unraid host — PLANNING.md.)
 */
function buildPokSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const pokEnv = [
    `INSTANCE_NAME=${containerName(input.serverId, input.game)}`,
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    `MAP_NAME=${input.map}`, // POK passes through any *_WP value
    `SESSION_NAME=${input.sessionName}`,
    `SERVER_ADMIN_PASSWORD=${input.adminPassword}`,
    `SERVER_PASSWORD=${serverPassword(input)}`,
    `ASA_PORT=${ports.game}`,
    `RCON_PORT=${ports.rcon}`,
    `RCON_ENABLED=TRUE`, // required for the in-app RCON console
    `MAX_PLAYERS=${input.maxPlayers}`,
    `MOD_IDS=${(input.modIds ?? []).join(",")}`,
    `CLUSTER_ID=${input.cluster?.clusterId ?? ""}`,
    `BATTLEEYE=${isBattlEyeDisabled(input.config) ? "FALSE" : "TRUE"}`,
    // POK adds -clusterid from CLUSTER_ID but never sets -ClusterDirOverride, so
    // separate containers wouldn't share a transfer dir. We point ARK at the
    // shared mount ourselves (appended to the custom args POK splices verbatim).
    `CUSTOM_SERVER_ARGS=${[
      buildCustomArgs(input.catalog, input.config),
      input.cluster ? `-ClusterDirOverride=${ContainerPaths.pokCluster}` : "",
    ]
      .filter(Boolean)
      .join(" ")}`,
    `UPDATE_SERVER=TRUE`, // POK installs/updates game files on (first) boot
    `DISPLAY_POK_MONITOR_MESSAGE=FALSE`,
  ];

  // POK rewrites the [MessageOfTheDay] section of GameUserSettings.ini on every
  // launch from these env vars (stripping whatever we render), so the MOTD must
  // be passed through here or it gets dropped. Verified against POK init scripts
  // + a real boot (PLANNING.md → config injection).
  const motd = readMotd(input.config);
  if (motd && motd.message.trim()) {
    pokEnv.push("ENABLE_MOTD=TRUE", `MOTD=${motd.message}`, `MOTD_DURATION=${motd.duration || 20}`);
  } else {
    pokEnv.push("ENABLE_MOTD=FALSE");
  }

  // Whole instance dir (install + saves + config) → POK's data dir; plus the
  // shared cluster transfer dir when this server belongs to a cluster.
  const binds = [`${HostPaths.instanceRoot(input.serverId)}:${POK_DATA_DIR}`];
  if (input.cluster) {
    binds.push(`${HostPaths.cluster(input.cluster.clusterId)}:${ContainerPaths.pokCluster}`);
  }

  // Host network removes the Docker NAT layer (better ASA/EOS listing); on the
  // bridge we publish the game + RCON ports and attach to ark-net instead.
  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.ASA],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: pokEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "udp")]: {},
            [portKey(ports.rcon, "tcp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.rcon, "tcp")]: [{ HostPort: String(ports.rcon) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
      // ASA wants a high fd limit; POK warns it can't raise it itself.
      Ulimits: [{ Name: "nofile", Soft: 100000, Hard: 100000 }],
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/**
 * ASE: drive the proven hermsi/ark-server image (arkmanager-based) via env vars.
 * It installs the game files + mods itself on first boot (into <vol>/server),
 * reads our injected INIs under server/ShooterGame/Saved/Config/LinuxServer, and
 * runs the native Linux ShooterGameServer. The manager renders the INIs + sets
 * these env vars; RCON works over the shared network. (Contract verified against
 * the image's entrypoints on a real Unraid host — PLANNING.md.)
 */
function buildAseSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const aseEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `SESSION_NAME=${input.sessionName}`,
    `SERVER_MAP=${input.map}`,
    `ADMIN_PASSWORD=${input.adminPassword}`,
    `SERVER_PASSWORD=${serverPassword(input)}`,
    `MAX_PLAYERS=${input.maxPlayers}`,
    `GAME_MOD_IDS=${(input.modIds ?? []).join(",")}`,
    `GAME_CLIENT_PORT=${ports.game}`,
    `UDP_SOCKET_PORT=${ports.rawSocket}`,
    `RCON_PORT=${ports.rcon}`,
    `SERVER_LIST_PORT=${ports.query}`,
    `UPDATE_ON_START=true`, // install/update game files + mods on (first) boot
    `DISABLE_BATTLEYE=${isBattlEyeDisabled(input.config) ? "true" : "false"}`,
  ];

  // arkmanager forwards container Cmd args to the server via `--arkopt,-Flag`.
  // hermsi exposes no cluster env, so (like POK) we point ARK at the shared mount
  // ourselves. NOTE: ASE cluster transfers are wired but not yet boot-validated.
  const cmd = input.cluster
    ? [
        `--arkopt,-clusterid=${input.cluster.clusterId}`,
        `--arkopt,-ClusterDirOverride=${ContainerPaths.hermsiCluster}`,
      ]
    : undefined;

  const binds = [`${HostPaths.instanceRoot(input.serverId)}:${HERMSI_VOLUME}`];
  if (input.cluster) {
    binds.push(`${HostPaths.cluster(input.cluster.clusterId)}:${ContainerPaths.hermsiCluster}`);
  }

  const exposed: Docker.ContainerCreateOptions["ExposedPorts"] = {
    [portKey(ports.game, "udp")]: {},
    [portKey(ports.rawSocket, "udp")]: {},
    [portKey(ports.query, "udp")]: {},
    [portKey(ports.rcon, "tcp")]: {},
  };
  const bindings: Record<string, Array<{ HostPort: string }>> = {
    [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
    [portKey(ports.rawSocket, "udp")]: [{ HostPort: String(ports.rawSocket) }],
    [portKey(ports.query, "udp")]: [{ HostPort: String(ports.query) }],
    [portKey(ports.rcon, "tcp")]: [{ HostPort: String(ports.rcon) }],
  };

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.ASE],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Cmd: cmd,
    Env: aseEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet ? {} : { ExposedPorts: exposed }),
    HostConfig: {
      Binds: binds,
      ...(hostNet ? { NetworkMode: "host" } : { PortBindings: bindings }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
      Ulimits: [{ Name: "nofile", Soft: 100000, Hard: 100000 }],
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Catalog Env-target settings → env var strings (Conan's image writes its INIs
 *  from these). Bools become true/false; everything else is stringified. */
function conanCatalogEnv(input: RuntimeSpecInput): string[] {
  const out: string[] = [];
  const str = (v: unknown) => (typeof v === "boolean" ? (v ? "true" : "false") : String(v));
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const emitAs = def.emitAs ?? def.key;
    const set = input.config.values?.[def.key];
    // Raw ServerSettings overrides (CONAN_SETTING_*) are only sent when the user
    // changed them from the catalog default — so the game keeps its own vanilla
    // default for every untouched knob, and an approximate catalog default can
    // never silently change server behavior. First-class env vars always send
    // (they mirror the image's own keys + our opinionated defaults, e.g. Region).
    if (emitAs.startsWith("CONAN_SETTING_")) {
      if (set === undefined || set === null) continue;
      if (JSON.stringify(set) === JSON.stringify(def.default)) continue;
      out.push(`${emitAs}=${str(set)}`);
    } else {
      const raw = set ?? def.default;
      if (raw === undefined || raw === null) continue;
      out.push(`${emitAs}=${str(raw)}`);
    }
  }
  return out;
}

/**
 * Conan Exiles (Enhanced): drive acekorneya/conan_enhanced_server via env vars.
 * The image installs the native Linux server (app 443030) + Workshop mods on boot
 * and writes ServerSettings.ini / Engine.ini / Game.ini itself from env — so we
 * deliver config as env (no INI rendering) and read RCON over the shared network.
 * We disable the image's own watchdog/auto-update/daily-restart since the manager
 * owns the lifecycle. (Contract extracted from the image's configure-server.sh.)
 */
function buildConanSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const conanEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    `SERVER_NAME=${input.sessionName}`,
    `SERVER_PASSWORD=${serverPassword(input)}`,
    `ADMIN_PASSWORD=${input.adminPassword}`,
    `RCON_ENABLED=true`,
    `RCON_PASSWORD=${input.adminPassword}`, // manager's RCON authenticates with the admin password
    `RCON_PORT=${ports.rcon}`,
    `SERVER_PORT=${ports.game}`,
    `RAW_UDP_PORT=${ports.rawSocket}`,
    `QUERY_PORT=${ports.query}`,
    `MAX_PLAYERS=${input.maxPlayers}`,
    `MOD_IDS=${(input.modIds ?? []).join(",")}`,
    // The manager owns updates/restarts/health — turn off the image's own loops.
    `AUTO_UPDATE=false`,
    `SERVER_WATCHDOG_ENABLED=false`,
    `DAILY_RESTART_ENABLED=false`,
    ...conanCatalogEnv(input),
  ];

  // Bind the whole instance dir → /data, PLUS each of the image's VOLUME-declared
  // subdirs explicitly. The image declares `VOLUME /data/server`, `/data/steam`,
  // `/data/backups`; without explicit binds Docker shadows them with throwaway
  // anonymous volumes, so the ~4.7GB game install and world saves never reach the
  // instance dir — lost on every container recreate, invisible to backups and disk
  // stats. Binding each subdir at its VOLUME path defeats the anonymous volume.
  // (saves land at server/ConanSandbox/Saved beneath the instance dir.)
  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [
    `${root}:${CONAN_DATA_DIR}`,
    `${root}/server:${CONAN_DATA_DIR}/server`,
    `${root}/steam:${CONAN_DATA_DIR}/steam`,
    `${root}/backups:${CONAN_DATA_DIR}/backups`,
  ];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.CONAN],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: conanEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "udp")]: {},
            [portKey(ports.query, "udp")]: {},
            [portKey(ports.rcon, "tcp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.rawSocket, "udp")]: [{ HostPort: String(ports.rawSocket) }],
              [portKey(ports.query, "udp")]: [{ HostPort: String(ports.query) }],
              [portKey(ports.rcon, "tcp")]: [{ HostPort: String(ports.rcon) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Palworld (thijsvanloef/palworld-server-docker): env-driven, RCON via ADMIN_PASSWORD. */
function buildPalworldSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const palEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`, // image refuses to run as root; PUID/PGID must be non-zero
    `PGID=${env.PGID}`,
    `SERVER_NAME=${input.sessionName}`,
    `SERVER_PASSWORD=${serverPassword(input)}`,
    `ADMIN_PASSWORD=${input.adminPassword}`, // also the RCON password (rcon.yaml uses ADMIN_PASSWORD)
    `RCON_ENABLED=true`,
    `RCON_PORT=${ports.rcon}`,
    `PORT=${ports.game}`,
    `QUERY_PORT=${ports.query}`,
    `PLAYERS=${input.maxPlayers}`,
    `MULTITHREADING=true`,
    // The manager owns updates/backups/restarts — turn off the image's own loops.
    // (A fresh instance still installs on first boot regardless of UPDATE_ON_BOOT.)
    `UPDATE_ON_BOOT=false`,
    `BACKUP_ENABLED=false`,
    `AUTO_REBOOT_ENABLED=false`,
    // Server-side mod framework (UE4SS/PalDefender): when enabled, preload its
    // loader so the native-Linux server injects it. The framework files live in the
    // bind-mounted Pal/Binaries/Linux (managed via the Mods tab / PalModsService).
    ...(input.config.values?.["_palFramework"]
      ? [
          `LD_PRELOAD=${PALWORLD_DATA_DIR}/${
            (input.config.values?.["_palFrameworkPreload"] as string) ||
            "Pal/Binaries/Linux/libUE4SS.so"
          }`,
        ]
      : []),
    ...palworldCatalogEnv(input),
  ];

  // No VOLUME declarations in the image, so one bind covers the whole install +
  // saves (saves at Pal/Saved/SaveGames beneath the instance dir).
  const binds = [`${HostPaths.instanceRoot(input.serverId)}:${PALWORLD_DATA_DIR}`];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.PALWORLD],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: palEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "udp")]: {},
            [portKey(ports.query, "udp")]: {},
            [portKey(ports.rcon, "tcp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.query, "udp")]: [{ HostPort: String(ports.query) }],
              [portKey(ports.rcon, "tcp")]: [{ HostPort: String(ports.rcon) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Palworld settings -> env vars. Booleans become PalWorldSettings.ini's True/False. */
function palworldCatalogEnv(input: RuntimeSpecInput): string[] {
  const out: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null) continue;
    const val = typeof raw === "boolean" ? (raw ? "True" : "False") : String(raw);
    out.push(`${def.emitAs ?? def.key}=${val}`);
  }
  return out;
}

/**
 * Minecraft (Java): drive itzg/minecraft-server via env vars. The image downloads
 * the chosen server jar (TYPE/VERSION from the catalog) on first boot, writes
 * server.properties from these vars, and exposes RCON. Unlike the ARK/Conan/Palworld
 * images this is plain TCP on a single game port (25565) + RCON (25575). EULA is
 * accepted on the user's behalf by creating the server. The "map" field carries the
 * world-generation type (LEVEL_TYPE); the world folder is always "world".
 */
function buildMinecraftSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  // Give the JVM ~80% of the container's RAM cap (the rest covers JVM off-heap,
  // metaspace + the OS); fall back to 3 GB when the server has no explicit cap.
  const heapMb = input.ramLimitMb ? Math.max(1024, Math.floor(input.ramLimitMb * 0.8)) : 3072;

  // A selected CurseForge modpack (stored in config by the Mods tab) switches the
  // image to AUTO_CURSEFORGE: it downloads the pack + loader + every mod using the
  // user's API key. The pack dictates the server flavour + MC version, so the
  // catalog's TYPE/VERSION are suppressed in favour of the modpack's.
  const slug = input.config.values?.["_mcModpackSlug"] as string | undefined;
  const fileId = input.config.values?.["_mcModpackFileId"];
  const usingModpack = Boolean(slug && input.curseForgeApiKey);

  const catalogEnv = minecraftCatalogEnv(input).filter(
    (e) => !usingModpack || (!e.startsWith("TYPE=") && !e.startsWith("VERSION=")),
  );

  const mcEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `UID=${env.PUID}`, // itzg reads UID/GID (not PUID/PGID) to own /data
    `GID=${env.PGID}`,
    `EULA=TRUE`, // accepted by creating the server through the manager
    `SERVER_PORT=${ports.game}`,
    `ENABLE_RCON=true`,
    `RCON_PORT=${ports.rcon}`,
    `RCON_PASSWORD=${input.adminPassword}`, // the manager's RCON authenticates with this
    `BROADCAST_RCON_TO_OPS=false`, // don't echo our management commands to in-game ops
    `MAX_PLAYERS=${input.maxPlayers}`,
    `MOTD=${input.sessionName}`, // shown next to the server in the client's list
    `LEVEL_TYPE=${input.map}`, // world-generation type (e.g. minecraft:normal)
    `LEVEL=world`,
    `MEMORY=${heapMb}M`,
    ...catalogEnv,
    ...(usingModpack
      ? [
          `TYPE=AUTO_CURSEFORGE`,
          `CF_API_KEY=${input.curseForgeApiKey}`,
          `CF_SLUG=${slug}`,
          ...(fileId ? [`CF_FILE_ID=${fileId}`] : []),
        ]
      : []),
  ];

  // One bind covers the jar, config + all worlds (overworld at /data/world).
  const binds = [`${HostPaths.instanceRoot(input.serverId)}:${MINECRAFT_DATA_DIR}`];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.MINECRAFT],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: mcEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "tcp")]: {},
            [portKey(ports.rcon, "tcp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "tcp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.rcon, "tcp")]: [{ HostPort: String(ports.rcon) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Minecraft settings -> itzg env vars. Booleans become true/false; empty strings
 *  are dropped so an unset SEED/OPS/whitelist leaves the image's own default. */
function minecraftCatalogEnv(input: RuntimeSpecInput): string[] {
  const out: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    const val = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw);
    out.push(`${def.emitAs ?? def.key}=${val}`);
  }
  return out;
}

/**
 * Icarus (mornedhels/icarus-server): env-driven, run under Wine. The image installs
 * the Icarus server via SteamCMD on boot and writes ServerSettings.ini from these
 * env vars. Two UDP ports (game + Steam query); NO network RCON (admin is in-game
 * chat), so nothing RCON-related is wired. The world is a "prospect" players pick
 * in-game. Config + saves and the ~15 GB game files are bound separately.
 */
function buildIcarusSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const icarusEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    `SERVER_NAME=${input.sessionName}`,
    `SERVER_PASSWORD=${serverPassword(input)}`,
    `SERVER_ADMIN_PASSWORD=${input.adminPassword}`, // gates the in-game /AdminLogin
    `SERVER_MAX_PLAYERS=${input.maxPlayers}`,
    `SERVER_PORT=${ports.game}`,
    `SERVER_QUERYPORT=${ports.query}`,
    `UPDATE_SKIP=false`, // install/validate the game files on (first) boot
    ...icarusCatalogEnv(input),
  ];

  // Bind config + saves and the game files to their own instance subdirs — so the
  // small config+saves dir (backups/disk stats target it) is separate from the big
  // SteamCMD install. (savedDir(ICARUS) points at the "config" subdir.)
  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [`${root}/config:${ICARUS_CONFIG_DIR}`, `${root}/gamefiles:${ICARUS_GAME_DIR}`];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.ICARUS],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: icarusEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "udp")]: {},
            [portKey(ports.query, "udp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.query, "udp")]: [{ HostPort: String(ports.query) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Icarus settings -> mornedhels env vars. Booleans become ServerSettings' True/False. */
function icarusCatalogEnv(input: RuntimeSpecInput): string[] {
  const out: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null) continue;
    const val = typeof raw === "boolean" ? (raw ? "True" : "False") : String(raw);
    out.push(`${def.emitAs ?? def.key}=${val}`);
  }
  return out;
}

/**
 * Minecraft Bedrock (itzg/minecraft-bedrock-server): env-driven, like the Java image
 * but the native Bedrock server — UDP on 19132 (IPv4) + 19133 (IPv6) and NO RCON
 * (console is stdin-only), so nothing RCON-related is wired. The "map" field carries
 * the world-generation type (LEVEL_TYPE); the world folder is always "world".
 */
function buildBedrockSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const bedrockEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `UID=${env.PUID}`,
    `GID=${env.PGID}`,
    `EULA=TRUE`, // accepted by creating the server through the manager
    `SERVER_NAME=${input.sessionName}`,
    `SERVER_PORT=${ports.game}`, // IPv4 UDP
    `SERVER_PORT_V6=${ports.rawSocket}`, // IPv6 UDP
    `MAX_PLAYERS=${input.maxPlayers}`,
    `LEVEL_NAME=world`,
    `LEVEL_TYPE=${input.map}`, // DEFAULT / FLAT / LEGACY
    ...bedrockCatalogEnv(input),
  ];

  // One bind covers the server + config + worlds (worlds at /data/worlds).
  const binds = [`${HostPaths.instanceRoot(input.serverId)}:${BEDROCK_DATA_DIR}`];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.BEDROCK],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: bedrockEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "udp")]: {},
            [portKey(ports.rawSocket, "udp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.rawSocket, "udp")]: [{ HostPort: String(ports.rawSocket) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Bedrock settings -> itzg env vars. Booleans become true/false; empty strings are
 *  dropped so an unset LEVEL_SEED leaves the image's own default. */
function bedrockCatalogEnv(input: RuntimeSpecInput): string[] {
  const out: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    const val = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw);
    out.push(`${def.emitAs ?? def.key}=${val}`);
  }
  return out;
}

/**
 * Valheim (lloesche/valheim-server): env-driven, native Linux. The image installs the
 * server via SteamCMD on boot and builds its launch line from these env vars. UDP on
 * 2456 (game) + 2457 (query) + 2458 (crossplay); NO RCON. It runs as root by default
 * (we don't set PUID/PGID), so the root-owned instance binds work without a chown.
 * Valheim REQUIRES a join password of >= 5 chars (validated at create).
 */
function buildValheimSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const valheimEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `SERVER_NAME=${input.sessionName}`,
    `SERVER_PASS=${serverPassword(input)}`, // >= 5 chars, enforced at create
    `SERVER_PORT=${ports.game}`, // query is game+1 (2457), crossplay is game+2 (2458)
    ...valheimCatalogEnv(input),
  ];

  // Config + worlds under /config; the SteamCMD game install under /opt/valheim.
  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [`${root}/config:${VALHEIM_CONFIG_DIR}`, `${root}/gamefiles:${VALHEIM_GAME_DIR}`];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.VALHEIM],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: valheimEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "udp")]: {},
            [portKey(ports.query, "udp")]: {},
            [portKey(ports.rawSocket, "udp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.query, "udp")]: [{ HostPort: String(ports.query) }],
              [portKey(ports.rawSocket, "udp")]: [{ HostPort: String(ports.rawSocket) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Valheim settings -> lloesche env vars. Booleans become true/false; empty dropped. */
function valheimCatalogEnv(input: RuntimeSpecInput): string[] {
  const out: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    const val = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw);
    out.push(`${def.emitAs ?? def.key}=${val}`);
  }
  return out;
}

/**
 * 7 Days to Die (vinanrra/LinuxGSM): env vars here drive the CONTAINER/LinuxGSM
 * (install/update/start, no LinuxGSM backup/monitor loops since the manager owns the
 * lifecycle). The game's own settings live in sdtdserver.xml, which the manager
 * renders into the serverfiles bind (see ServersService.writeInis). The game port is
 * 26900 (TCP + UDP) + 26901/26902 UDP; the telnet console ("RCON") is 8081/TCP. Runs
 * as env.PUID/PGID, so the root-owned instance binds are chowned before start.
 */
function buildSevenDaysSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const sdtdEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    `START_MODE=1`, // install/update if needed, then start (LinuxGSM)
    `VERSION=stable`,
    `BACKUP=NO`, // manager owns backups
    `MONITOR=NO`, // manager owns the crash watchdog
  ];

  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [
    `${root}/serverfiles:${SEVEN_DAYS_SERVERFILES_DIR}`, // ~20 GB game install + sdtdserver.xml
    `${root}/saves:${SEVEN_DAYS_SAVES_DIR}`, // world + player saves
  ];

  const exposed: Docker.ContainerCreateOptions["ExposedPorts"] = {
    [portKey(ports.game, "tcp")]: {},
    [portKey(ports.game, "udp")]: {},
    [portKey(ports.rawSocket, "udp")]: {},
    [portKey(ports.query, "udp")]: {},
    [portKey(ports.rcon, "tcp")]: {}, // 8081 telnet
  };
  const bindings: Record<string, Array<{ HostPort: string }>> = {
    [portKey(ports.game, "tcp")]: [{ HostPort: String(ports.game) }],
    [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
    [portKey(ports.rawSocket, "udp")]: [{ HostPort: String(ports.rawSocket) }],
    [portKey(ports.query, "udp")]: [{ HostPort: String(ports.query) }],
    [portKey(ports.rcon, "tcp")]: [{ HostPort: String(ports.rcon) }],
  };

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.SEVEN_DAYS],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: sdtdEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet ? {} : { ExposedPorts: exposed }),
    HostConfig: {
      Binds: binds,
      ...(hostNet ? { NetworkMode: "host" } : { PortBindings: bindings }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/**
 * Enshrouded (mornedhels/enshrouded-server): env-driven, runs the Windows server under
 * Proton (same family as Icarus). The image installs the game via SteamCMD on boot and
 * translates env vars into enshrouded_server.json. UDP on 15636 (game) + 15637 (query);
 * NO RCON. Runs as PUID/PGID (the image chowns its mounts on startup, so the root-owned
 * instance binds work without a manager-side chown). SERVER_PASSWORD is deprecated — the
 * join password is role-based, so we define three roles (Admin/Friend/Guest) with unique
 * passwords derived from the join password (validated >= 5 chars at create).
 */
function buildEnshroudedSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;
  // Enshrouded caps concurrent players at 16.
  const slots = Math.min(Math.max(input.maxPlayers, 1), 16);

  const enshroudedEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    `SERVER_NAME=${input.sessionName}`,
    `SERVER_SLOT_COUNT=${slots}`,
    `SERVER_GAME_PORT=${ports.game}`, // 15636 (also the image default)
    `SERVER_QUERYPORT=${ports.query}`, // 15637
    `GAME_BRANCH=public`,
    ...enshroudedRoleEnv(input),
    ...enshroudedCatalogEnv(input),
  ];

  // One bind covers the game install + enshrouded_server.json + the savegame dir
  // (savegame at /opt/enshrouded/savegame; savedDir(ENSHROUDED) -> gamefiles/savegame).
  const binds = [`${HostPaths.instanceRoot(input.serverId)}/gamefiles:${ENSHROUDED_GAME_DIR}`];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.ENSHROUDED],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: enshroudedEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "udp")]: {},
            [portKey(ports.query, "udp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.query, "udp")]: [{ HostPort: String(ports.query) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/**
 * Enshrouded's join password is role-based (userGroups in enshrouded_server.json).
 * The default config ships three password-protected roles, so we overwrite all three
 * (indices 0/1/2) via the image's SERVER_ROLE_<i>_* env vars with unique passwords
 * derived from the single join password — leaving no unknown shipped default:
 *   Guest  (<pw>)        — the everyone password; full co-op build perms.
 *   Friend (<pw>-friend) — same perms; distinct password.
 *   Admin  (<pw>-admin)  — the elevated password; can also kick/ban.
 * Passwords must be unique per role or the server crashes on boot; the suffixes
 * guarantee that. Booleans emit as true/false.
 */
function enshroudedRoleEnv(input: RuntimeSpecInput): string[] {
  const pw = serverPassword(input);
  const role = (i: number, name: string, password: string, kickBan: boolean): string[] => [
    `SERVER_ROLE_${i}_NAME=${name}`,
    `SERVER_ROLE_${i}_PASSWORD=${password}`,
    `SERVER_ROLE_${i}_CAN_KICK_BAN=${kickBan ? "true" : "false"}`,
    `SERVER_ROLE_${i}_CAN_ACCESS_INVENTORIES=true`,
    `SERVER_ROLE_${i}_CAN_EDIT_BASE=true`,
    `SERVER_ROLE_${i}_CAN_EXTEND_BASE=true`,
  ];
  return [
    ...role(0, "Admin", `${pw}-admin`, true),
    ...role(1, "Friend", `${pw}-friend`, false),
    ...role(2, "Guest", pw, false),
  ];
}

/** Enshrouded settings -> mornedhels env vars. Booleans become true/false; empty dropped. */
function enshroudedCatalogEnv(input: RuntimeSpecInput): string[] {
  const out: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    const val = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw);
    out.push(`${def.emitAs ?? def.key}=${val}`);
  }
  return out;
}

/**
 * Render 7 Days to Die's sdtdserver.xml from a server's config. First-class fields
 * (name, join password, ports, telnet, max players, GameWorld from the map) plus the
 * catalog's gameplay properties. XML values are escaped. LinuxGSM launches the server
 * with -configfile pointing at this file.
 */
export function renderSdtdServerXml(input: {
  sessionName: string;
  serverPassword: string;
  adminPassword: string;
  maxPlayers: number;
  map: string;
  gamePort: number;
  telnetPort: number;
  catalog: SettingsCatalog;
  config: ServerConfigValues;
}): string {
  const esc = (v: unknown) =>
    String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const props: Record<string, string | number> = {
    ServerName: input.sessionName,
    ServerDescription: "",
    ServerPassword: input.serverPassword,
    ServerVisibility: 2, // 2 = public (listed), 1 = friends, 0 = not listed
    ServerPort: input.gamePort,
    ServerMaxPlayerCount: input.maxPlayers,
    GameWorld: input.map, // Navezgane or RWG
    // Telnet is 7DTD's remote console. Gated with the admin password + failed-login limit.
    TelnetEnabled: "true",
    TelnetPort: input.telnetPort,
    TelnetPassword: input.adminPassword,
    TelnetFailedLoginLimit: 10,
    TelnetFailedLoginsBlocktime: 10,
    // WebDashboard/control panel off by default (we don't publish 8080).
    WebDashboardEnabled: "false",
  };
  // Catalog gameplay properties (GameName, difficulty, rates, …).
  for (const def of input.catalog.settings) {
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null) continue;
    props[def.emitAs ?? def.key] = typeof raw === "boolean" ? (raw ? "true" : "false") : (raw as string | number);
  }
  const lines = Object.entries(props).map(
    ([name, value]) => `  <property name="${name}" value="${esc(value)}"/>`,
  );
  return `<?xml version="1.0"?>\n<ServerSettings>\n${lines.join("\n")}\n</ServerSettings>\n`;
}
