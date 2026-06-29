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
import { IMAGES, POK_DATA_DIR, HERMSI_VOLUME, CONAN_DATA_DIR, PALWORLD_DATA_DIR } from "../common/images";
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
}

/** Build the Docker create spec for a game-server container. */
export function buildContainerSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  if (input.game === Game.ASA) return buildPokSpec(input);
  if (input.game === Game.CONAN) return buildConanSpec(input);
  if (input.game === Game.PALWORLD) return buildPalworldSpec(input);
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
