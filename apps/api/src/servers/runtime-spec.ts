import type Docker from "dockerode";
import {
  Game,
  GAME_ICONS,
  type PortSet,
  type ServerConfigValues,
  type SettingsCatalog,
  type MotdValue,
} from "@ark/shared";
import { buildCustomArgs, isBattlEyeDisabled } from "../catalog/command-line";
import { HostPaths, ContainerPaths } from "../common/paths";
import { IMAGES, POK_DATA_DIR, HERMSI_VOLUME } from "../common/images";
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
  return input.game === Game.ASA ? buildPokSpec(input) : buildAseSpec(input);
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
    `INSTANCE_NAME=${containerName(input.serverId)}`,
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
    name: containerName(input.serverId, input.sessionName),
    Image: IMAGES[Game.ASA],
    Hostname: containerName(input.serverId, input.sessionName),
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
    name: containerName(input.serverId, input.sessionName),
    Image: IMAGES[Game.ASE],
    Hostname: containerName(input.serverId, input.sessionName),
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
