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
import { VALHEIM_MODIFIER_CATEGORY } from "../catalog/valheim.catalog";
import { ENSHROUDED_MINUTE_NS_KEYS } from "../catalog/enshrouded.catalog";
import { HostPaths, ContainerPaths } from "../common/paths";
import {
  IMAGES,
  imageRefFor,
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
  ZOMBOID_DATA_DIR,
  VRISING_SERVER_DIR,
  VRISING_DATA_DIR,
  SOTF_GAME_DIR,
  SATISFACTORY_CONFIG_DIR,
  LIF_STEAMCMD_DIR,
  LIF_SERVERFILES_DIR,
  CORE_KEEPER_FILES_DIR,
  CORE_KEEPER_DATA_DIR,
  TERRARIA_WORLDS_DIR,
  TERRARIA_PLUGINS_DIR,
  TERRARIA_LOGS_DIR,
  FACTORIO_DATA_DIR,
  RUST_DATA_DIR,
  BEAMMP_CLIENT_MODS_DIR,
  BEAMMP_SERVER_MODS_DIR,
  OPENTTD_DATA_DIR,
} from "../common/images";
// (ATS reuses the ich777 wrapper mount points LIF_STEAMCMD_DIR / LIF_SERVERFILES_DIR.)
import { ZOMBOID_STEAM_PORTS } from "../catalog/ports";
import { SOTF_GAME_SETTINGS_KEYS } from "../catalog/sotf.catalog";
import { LIF_SKILLCAP_GROUPS } from "../catalog/lif.catalog";
import { TERRARIA_CLI_KEYS } from "../catalog/terraria.catalog";
import { FACTORIO_ENV_KEYS } from "../catalog/factorio.catalog";
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
  /** Zomboid only: the in-game "Mod ID" names (Mods=) matching modIds (WorkshopItems=). */
  pzModNames?: string[];
  /** Square icon for the Unraid Docker dashboard (per-server pick or SGDB game
   *  default); falls back to the game's Steam header when absent. */
  iconUrl?: string | null;
  /** Advanced: pin the game image to a specific tag (e.g. a prior version) instead of
   *  the shipped default. Invalid/blank falls back to the default tag. */
  imageTag?: string | null;
}

/** Build the Docker create spec for a game-server container. */
export function buildContainerSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const spec = hardenSpec(gameSpecFor(input), input.game);
  // Each game spec sets Image to its shipped default; apply a pinned tag here (one
  // choke point) so an advanced user can run a specific version.
  spec.Image = imageRefFor(input.game, input.imageTag);
  return spec;
}

/**
 * Sanitize a user-chosen game version/branch (from the settings dropdown) into a safe
 * token, falling back to the shipped default when unset or malformed. Accepts version
 * ids and branch names — "1.20.4", "26.3-snapshot-3", "15.3", "16.0-beta1", "latest",
 * "stable", "latest_experimental", "LATEST". The value reaches a Docker env array (not
 * a shell), but constraining the shape keeps a junk value out of the image's launch
 * scripts and preserves the default's behaviour for existing servers.
 */
export function gameVersionValue(raw: unknown, fallback: string): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? v : fallback;
}

/**
 * ich777 GAME_ID with an optional Steam beta branch. The wrapper installs the default
 * "public" branch from "<appid>", or a specific version/beta from "<appid> -beta <branch>"
 * (per the image docs). Used by the truck sims + LiF, whose game version is a Steam branch.
 */
export function ich777GameId(appId: number, branch: unknown): string {
  const b = gameVersionValue(branch, "public");
  return b && b !== "public" ? `${appId} -beta ${b}` : `${appId}`;
}

/**
 * The POK images (ASA + Conan, both Acekorneya) run `sudo` in their entrypoints,
 * and sudo refuses to run under no-new-privileges EVEN AS ROOT (it checks the
 * flag explicitly) — the container dies before printing a line. gosu/su-based
 * images are unaffected (dropping FROM root needs no escalation), so only these
 * two are exempt. Found live: Conan crash-looped with
 * "sudo: The 'no new privileges' flag is set". They still get the PidsLimit.
 */
const NO_NEW_PRIVS_EXEMPT = new Set<Game>([Game.ASA, Game.CONAN]);

/**
 * Defense-in-depth applied to every game container: no-new-privileges blocks
 * privilege escalation through setuid binaries (root dropping to a game user
 * via su/gosu still works — that direction needs no escalation), and PidsLimit
 * keeps a fork bomb inside a compromised game server from exhausting the host.
 * 8192 is far above real usage, but UE5-under-Proton servers run 1-2k threads
 * and threads count against the limit — hence not lower.
 */
function hardenSpec(spec: Docker.ContainerCreateOptions, game: Game): Docker.ContainerCreateOptions {
  const host = (spec.HostConfig ??= {});
  if (!NO_NEW_PRIVS_EXEMPT.has(game)) {
    host.SecurityOpt = [...(host.SecurityOpt ?? []), "no-new-privileges:true"];
  }
  host.PidsLimit ??= 8192;
  return spec;
}

function gameSpecFor(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  if (input.game === Game.ASA) return buildPokSpec(input);
  if (input.game === Game.CONAN) return buildConanSpec(input);
  if (input.game === Game.PALWORLD) return buildPalworldSpec(input);
  if (input.game === Game.PALWORLD_WINE) return buildPalworldWineSpec(input);
  if (input.game === Game.MINECRAFT) return buildMinecraftSpec(input);
  if (input.game === Game.ICARUS) return buildIcarusSpec(input);
  if (input.game === Game.BEDROCK) return buildBedrockSpec(input);
  if (input.game === Game.VALHEIM) return buildValheimSpec(input);
  if (input.game === Game.SEVEN_DAYS) return buildSevenDaysSpec(input);
  if (input.game === Game.ENSHROUDED) return buildEnshroudedSpec(input);
  if (input.game === Game.ZOMBOID) return buildZomboidSpec(input);
  if (input.game === Game.VRISING) return buildVRisingSpec(input);
  if (input.game === Game.SOTF) return buildSotfSpec(input);
  if (input.game === Game.SATISFACTORY) return buildSatisfactorySpec(input);
  if (input.game === Game.LIF) return buildLifSpec(input);
  if (input.game === Game.ATS || input.game === Game.ETS2) return buildAtsSpec(input);
  if (input.game === Game.CORE_KEEPER) return buildCoreKeeperSpec(input);
  if (input.game === Game.TERRARIA) return buildTerrariaSpec(input);
  if (input.game === Game.FACTORIO) return buildFactorioSpec(input);
  if (input.game === Game.RUST) return buildRustSpec(input);
  if (input.game === Game.BEAMMP) return buildBeammpSpec(input);
  if (input.game === Game.OPENTTD) return buildOpenttdSpec(input);
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
    // SteamGridDB square icon (per-server pick or game default) beats the wide
    // Steam header.jpg that Unraid squishes into its square dashboard slot.
    "net.unraid.docker.icon": input.iconUrl || GAME_ICONS[input.game],
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
    `UPDATE_ON_BOOT=true`,
    `BACKUP_ENABLED=false`,
    `AUTO_REBOOT_ENABLED=false`,
    // NOTE: the UE4SS mod framework is NOT preloaded via a container-wide LD_PRELOAD.
    // That injects libUE4SS.so into every process the image spawns (bash, steamcmd,
    // the rcon client) and segfaults them. ServerConfigWriter patches the preload
    // into Steam's PalServer.sh launch line instead — see patchPalServerLauncher.
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
function palworldCatalogEnv(input: RuntimeSpecInput, boolStyle: "True" | "true" = "True"): string[] {
  const out: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null) continue;
    const t = boolStyle === "True" ? ["True", "False"] : ["true", "false"];
    const val = typeof raw === "boolean" ? (raw ? t[0] : t[1]) : String(raw);
    out.push(`${def.emitAs ?? def.key}=${val}`);
  }
  return out;
}

/**
 * Palworld under Wine (ripps818/docker-palworld-dedicated-server-wine): runs the
 * WINDOWS PalServer.exe via Wine+Xvfb, which is what unlocks DLL mods (PalGuard,
 * PalDefender) that the native Linux binary can't load. Its env contract differs
 * from thijsvanloef's native image (PUBLIC_PORT vs PORT, MAX_PLAYERS vs PLAYERS,
 * MULTITHREAD_ENABLED vs MULTITHREADING, WindowsServer config dir, lowercase
 * bools), so it's a separate builder. The image renders PalWorldSettings.ini
 * from env; UE4SS installs the Windows way into Pal/Binaries/Win64 (no launcher
 * patch), so config-writer treats it as env-only. Uses gosu (not sudo) → the
 * no-new-privileges hardening is safe here.
 */
function buildPalworldWineSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;
  const name = containerName(input.serverId, input.game, input.sessionName);
  const hostNet = env.GAME_HOST_NETWORK;

  const palEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    // UE4SS ships as a dwmapi.dll proxy in Pal/Binaries/Win64; Wine only loads it if told
    // to prefer the native (proxy) dwmapi over its builtin. "n,b" = native-then-builtin,
    // so vanilla servers (no proxy on disk) still fall back to Wine's builtin. Without
    // this the framework files sit inert and DLL mods never load.
    `WINEDLLOVERRIDES=dwmapi=n,b`,
    // Without this the image defaults to SERVER_SETTINGS_MODE=manual and IGNORES every
    // env var above (ports, RCON, passwords, catalog) — the server then boots on its
    // hard-coded defaults (game 8211, RCON off). "auto" makes it envsubst our values
    // into PalWorldSettings.ini on each start.
    `SERVER_SETTINGS_MODE=auto`,
    `SERVER_NAME=${input.sessionName}`,
    `SERVER_PASSWORD=${serverPassword(input)}`,
    `ADMIN_PASSWORD=${input.adminPassword}`,
    `RCON_ENABLED=true`,
    `RCON_PORT=${ports.rcon}`,
    `PUBLIC_PORT=${ports.game}`,
    `MAX_PLAYERS=${input.maxPlayers}`,
    `MULTITHREAD_ENABLED=true`,
    // The manager owns updates/backups/restarts — silence the image's own loops.
    `ALWAYS_UPDATE_ON_START=false`,
    `BACKUP_ENABLED=false`,
    `RESTART_ENABLED=false`,
    ...palworldCatalogEnv(input, "true"),
  ];

  const binds = [`${HostPaths.instanceRoot(input.serverId)}:${PALWORLD_DATA_DIR}`];

  return {
    name,
    Image: IMAGES[Game.PALWORLD_WINE],
    Hostname: name,
    Env: palEnv,
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
      RestartPolicy: { Name: "no" },
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
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

  const serverArgs = valheimServerArgs(input);
  const valheimEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `SERVER_NAME=${input.sessionName}`,
    `SERVER_PASS=${serverPassword(input)}`, // >= 5 chars, enforced at create
    `SERVER_PORT=${ports.game}`, // query is game+1 (2457), crossplay is game+2 (2458)
    // Valheim doesn't answer direct A2S on its query port (queries go through
    // Steam's relay), so the manager reads player counts from the image's own
    // HTTP status endpoint instead — game port + 3 by convention (see PlayersService).
    `STATUS_HTTP=true`,
    `STATUS_HTTP_PORT=${ports.game + 3}`,
    ...valheimCatalogEnv(input),
    ...(serverArgs ? [`SERVER_ARGS=${serverArgs}`] : []),
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
            [portKey(ports.game + 3, "tcp")]: {}, // HTTP status (player counts)
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
              [portKey(ports.game + 3, "tcp")]: [{ HostPort: String(ports.game + 3) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Valheim settings -> lloesche env vars. Booleans become true/false; empty dropped.
 *  The "World modifiers" category is NOT env vars — it's compiled into SERVER_ARGS by
 *  valheimServerArgs, so skip it here. */
function valheimCatalogEnv(input: RuntimeSpecInput): string[] {
  const out: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    if (def.category === VALHEIM_MODIFIER_CATEGORY) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    const val = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw);
    out.push(`${def.emitAs ?? def.key}=${val}`);
  }
  return out;
}

/**
 * Compile Valheim's "World modifiers" settings into the launch-flag string the
 * lloesche image appends via SERVER_ARGS. PRESET -> `-preset <name>`; MOD_<name> ->
 * `-modifier <name> <value>`; KEY_<name> (a true bool) -> `-setkey <name>`. Empty /
 * "normal" values are skipped (use the game default). Returns "" when nothing is set.
 */
function valheimServerArgs(input: RuntimeSpecInput): string {
  const args: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.category !== VALHEIM_MODIFIER_CATEGORY) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (def.key === "PRESET") {
      if (typeof raw === "string" && raw) args.push(`-preset ${raw}`);
    } else if (def.key.startsWith("MOD_")) {
      if (typeof raw === "string" && raw) args.push(`-modifier ${def.key.slice(4)} ${raw}`);
    } else if (def.key.startsWith("KEY_")) {
      if (raw === true) args.push(`-setkey ${def.key.slice(4)}`);
    }
  }
  return args.join(" ");
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
    // Pinnable branch (default "stable"; "latest_experimental" for the beta) — set
    // via the settings dropdown. set_version.sh maps it to the LinuxGSM Steam branch.
    `VERSION=${gameVersionValue(input.config.values?.["VERSION"], "stable")}`,
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
    // GAME_BRANCH (default "public"; "testing" for the experimental branch) is emitted
    // by enshroudedCatalogEnv from its catalog setting — no hardcoded line here.
    ...enshroudedRoleEnv(input),
    ...enshroudedCatalogEnv(input),
  ];

  // One bind covers the game install + enshrouded_server.json + the savegame dir
  // (the image installs under /opt/enshrouded/server, so the save lands at
  // server/savegame inside the gamefiles bind — see LocalPaths.saveSubpaths).
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

/** Enshrouded settings -> mornedhels env vars. Booleans become true/false; empty
 *  dropped. The SERVER_GS_* duration knobs are edited in minutes but the game wants
 *  nanoseconds, so those keys are multiplied by 60e9 on the way out. */
function enshroudedCatalogEnv(input: RuntimeSpecInput): string[] {
  const out: string[] = [];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    const emit = def.emitAs ?? def.key;
    if (ENSHROUDED_MINUTE_NS_KEYS.has(emit)) {
      out.push(`${emit}=${Math.round(Number(raw) * 60_000_000_000)}`); // minutes -> nanoseconds
      continue;
    }
    const val = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw);
    out.push(`${emit}=${val}`);
  }
  return out;
}

/**
 * Project Zomboid: drive the danixu86 image via env vars. The game install is
 * baked into the image; only the Zomboid data dir (saves + server config + player
 * db) persists via the bind. The start script patches servertest.ini from env on
 * boot. Notes that shape this spec:
 * - ADMINPASSWORD is mandatory on first boot and also seeds RCONPASSWORD's user.
 * - SERVERNAME must have no spaces (it names the save); the browser-visible name
 *   is DISPLAYNAME. We fix SERVERNAME=servertest so DISPLAYNAME can change freely.
 * - RCON: Source protocol on the PZ ini default 27015 (no env to change it).
 * - Steam needs its two fixed comms ports (8766/8767 UDP) besides game + direct.
 * - Workshop mods: WORKSHOP_IDS (file ids) + MOD_IDS (in-game names) — semicolon
 *   separated; mods download on the NEXT start after being added.
 * - No max-players env — PZ's ini default applies; editable in-game by the admin.
 */
function buildZomboidSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const zomboidEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `ADMINUSERNAME=admin`,
    `ADMINPASSWORD=${input.adminPassword}`,
    `RCONPASSWORD=${input.adminPassword}`,
    `PASSWORD=${serverPassword(input)}`,
    `DISPLAYNAME=${input.sessionName}`,
    `SERVERNAME=servertest`,
    `PORT=${ports.game}`, // 16261
    `UDPPORT=${ports.rawSocket}`, // 16262 (direct connections)
    `STEAMPORT1=${ZOMBOID_STEAM_PORTS[0]}`,
    `STEAMPORT2=${ZOMBOID_STEAM_PORTS[1]}`,
    // Leaving these empty CLEARS existing values (per the image docs), which is
    // exactly right — the manager's mod list is the source of truth.
    `WORKSHOP_IDS=${input.modIds.join(";")}`,
    `MOD_IDS=${(input.pzModNames ?? []).join(";")}`,
    ...zomboidCatalogEnv(input),
  ];

  const binds = [`${HostPaths.instanceRoot(input.serverId)}/data:${ZOMBOID_DATA_DIR}`];

  const udpPorts = [ports.game, ports.rawSocket, ...ZOMBOID_STEAM_PORTS];
  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.ZOMBOID],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: zomboidEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            ...Object.fromEntries(udpPorts.map((p) => [portKey(p, "udp"), {}])),
            [portKey(ports.rcon, "tcp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              ...Object.fromEntries(
                udpPorts.map((p) => [portKey(p, "udp"), [{ HostPort: String(p) }]]),
              ),
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

/** Zomboid settings -> danixu86 env vars. Booleans become true/false; empty dropped. */
function zomboidCatalogEnv(input: RuntimeSpecInput): string[] {
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
 * V Rising: drive the trueosiris image via env vars. The image installs the game
 * via SteamCMD into the server bind and runs it under Wine; any HOST_SETTINGS_ /
 * GAME_SETTINGS_ prefixed env var patches the two settings JSONs in the
 * persistentdata bind on boot (`__` = one JSON nesting level, type-validated).
 * RCON is Source-protocol; we enable it + set the password via HOST_SETTINGS.
 * NOTE: the current image's /start.sh ships with CRLF line endings, so the
 * documented entrypoint override strips them before exec — drop it when upstream
 * fixes the script (it's harmless either way).
 */
function buildVRisingSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;
  const slots = Math.min(Math.max(input.maxPlayers, 1), 40);

  const vrisingEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `SERVERNAME=${input.sessionName}`,
    `WORLDNAME=world1`,
    `GAMEPORT=${ports.game}`, // 9876
    `QUERYPORT=${ports.query}`, // 9877
    `WINEDEBUG=fixme-all`, // silence Wine's fixme log spam
    `HOST_SETTINGS_Password=${serverPassword(input)}`,
    `HOST_SETTINGS_MaxConnectedUsers=${slots}`,
    `HOST_SETTINGS_Rcon__Enabled=true`,
    `HOST_SETTINGS_Rcon__Password=${input.adminPassword}`,
    `HOST_SETTINGS_Rcon__Port=${ports.rcon}`, // 25575
    ...vrisingCatalogEnv(input),
  ];

  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [
    `${root}/server:${VRISING_SERVER_DIR}`, // SteamCMD game install (~2 GB)
    `${root}/persistentdata:${VRISING_DATA_DIR}`, // saves + settings JSONs
  ];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.VRISING],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    // CRLF fix from the image's own README (see the function comment).
    Entrypoint: ["/bin/bash", "-c", "sed -i 's/\\r//g' /start.sh && exec /bin/bash /start.sh"],
    Env: vrisingEnv,
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

/** V Rising settings -> HOST_SETTINGS_/GAME_SETTINGS_ env vars. Booleans become
 *  true/false; empty strings dropped (the image ignores unknown/absent keys). */
function vrisingCatalogEnv(input: RuntimeSpecInput): string[] {
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
 * Sons of the Forest: drive the jammsen image. It installs the game (app 2465200)
 * via SteamCMD on boot into the single game bind and runs it under Wine as the
 * steam user (PUID/PGID, entrypoint chowns the bind). ALL settings live in
 * userdata/dedicatedserver.cfg — rendered by the manager (renderSotfConfig) before
 * every start; the image only seeds its example when the file is missing. NO RCON.
 */
function buildSotfSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const sotfEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    `ALWAYS_UPDATE_ON_START=true`,
    `SKIP_NETWORK_ACCESSIBILITY_TEST=true`,
    `FILTER_SHADER_AND_MESH_AND_WINE_DEBUG=true`, // strip Wine/shader log spam
  ];

  const binds = [`${HostPaths.instanceRoot(input.serverId)}/game:${SOTF_GAME_DIR}`];

  const udpPorts = [ports.game, ports.query, ports.rawSocket]; // 8766 / 27016 / 9700 (blob sync)
  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.SOTF],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: sotfEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : { ExposedPorts: Object.fromEntries(udpPorts.map((p) => [portKey(p, "udp"), {}])) }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: Object.fromEntries(
              udpPorts.map((p) => [portKey(p, "udp"), [{ HostPort: String(p) }]]),
            ),
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/**
 * Render Sons of the Forest's dedicatedserver.cfg (JSON). First-class fields
 * (name, join password, slots, ports, GameMode from the repurposed map field)
 * plus the catalog's cfg keys; the GS_ catalog keys land inside the nested
 * GameSettings object under the game's dotted names.
 */
export function renderSotfConfig(input: {
  sessionName: string;
  serverPassword: string;
  maxPlayers: number;
  map: string; // repurposed as GameMode (Normal/Hard/Peaceful/Creative)
  ports: PortSet;
  catalog: SettingsCatalog;
  config: ServerConfigValues;
}): string {
  const values: Record<string, unknown> = {};
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    values[def.key] = input.config.values?.[def.key] ?? def.default;
  }
  const gameSettings: Record<string, unknown> = {};
  for (const [key, dotted] of Object.entries(SOTF_GAME_SETTINGS_KEYS)) {
    if (values[key] !== undefined) {
      gameSettings[dotted] = values[key];
      delete values[key];
    }
  }
  const cfg = {
    IpAddress: "0.0.0.0",
    GamePort: input.ports.game,
    QueryPort: input.ports.query,
    BlobSyncPort: input.ports.rawSocket,
    ServerName: input.sessionName,
    MaxPlayers: Math.min(Math.max(input.maxPlayers, 1), 8),
    Password: input.serverPassword,
    SaveMode: "Continue",
    GameMode: input.map,
    LogFilesEnabled: false,
    TimestampLogFilenames: true,
    TimestampLogEntries: true,
    ...values,
    GameSettings: gameSettings,
    CustomGameModeSettings: {},
  };
  return JSON.stringify(cfg, null, 2);
}

/**
 * Satisfactory: drive the wolveix image via env vars. It installs the native Linux
 * server (app 1690800) via SteamCMD on boot into /config/gamefiles and runs it as
 * PUID/PGID. The game port carries UDP game traffic AND the TCP HTTPS server API;
 * 8888 TCP is the reliable-messaging port. There's no RCON — the manager claims
 * the server + reads player counts through the HTTPS API (satisfactory-api.ts).
 */
function buildSatisfactorySpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const satisfactoryEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    `MAXPLAYERS=${input.maxPlayers}`,
    `SERVERGAMEPORT=${ports.game}`, // 7777 (udp game + tcp API)
    `SERVERMESSAGINGPORT=${ports.rawSocket}`, // 8888 tcp
    ...satisfactoryCatalogEnv(input),
  ];

  const binds = [`${HostPaths.instanceRoot(input.serverId)}/config:${SATISFACTORY_CONFIG_DIR}`];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.SATISFACTORY],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: satisfactoryEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "udp")]: {},
            [portKey(ports.game, "tcp")]: {},
            [portKey(ports.rawSocket, "tcp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.game, "tcp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.rawSocket, "tcp")]: [{ HostPort: String(ports.rawSocket) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Satisfactory settings -> wolveix env vars. Booleans become true/false; empty dropped. */
function satisfactoryCatalogEnv(input: RuntimeSpecInput): string[] {
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
 * Life is Feudal: Your Own — drive ich777's lifyo SteamCMD wrapper. It installs
 * the Windows server (app 320850) via SteamCMD on boot, runs it under Wine, and
 * bundles the game's REQUIRED MariaDB inside the container (datadir persisted at
 * serverfiles/.database, connection seeded into config_local.cs). All server
 * settings live in serverfiles/config/world_1.xml, patched by patchLifWorldXml
 * before each start. NO RCON. The wrapper needs no per-game env beyond the app id.
 */
function buildLifSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const lifEnv = [
    `TZ=${input.timezone || env.TZ}`,
    // Pinnable via the STEAM_BRANCH setting (default "public"): dx9-legacy / vanilla-1.3.6 / …
    `GAME_ID=${ich777GameId(STEAM_APP_ID_LIF, input.config.values?.["STEAM_BRANCH"])}`,
    `GAME_PARAMS=-world 1`, // matches config/world_1.xml
    `UID=${env.PUID}`,
    `GID=${env.PGID}`,
    `VALIDATE=`,
  ];

  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [
    `${root}/steamcmd:${LIF_STEAMCMD_DIR}`, // SteamCMD itself (per-instance, tiny)
    `${root}/serverfiles:${LIF_SERVERFILES_DIR}`, // game + config + logs + MariaDB datadir
  ];

  // The server uses its base port + the two above (TCP AND UDP); the ich777
  // template maps a 4th (28003) as well, so publish the whole block both ways.
  const blockPorts = [ports.game, ports.rawSocket, ports.query, ports.game + 3];
  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.LIF],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: lifEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: Object.fromEntries(
            blockPorts.flatMap((p) => [
              [portKey(p, "tcp"), {}],
              [portKey(p, "udp"), {}],
            ]),
          ),
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: Object.fromEntries(
              blockPorts.flatMap((p) => [
                [portKey(p, "tcp"), [{ HostPort: String(p) }]],
                [portKey(p, "udp"), [{ HostPort: String(p) }]],
              ]),
            ),
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

const STEAM_APP_ID_LIF = 320850;

/**
 * Factorio — drive the canonical factoriotools image. The headless server is
 * baked in; one /factorio volume holds saves/config/mods. The map field carries
 * the map-gen PRESET for the save generated on first boot (GENERATE_NEW_SAVE
 * skips when the save already exists; LOAD_LATEST_SAVE then resumes the newest
 * autosave). PUID/PGID are honoured natively. RCON (Source) reads its password
 * from config/rconpw, which writeInis keeps in sync with the admin password.
 */
function buildFactorioSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const factorioEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    `SAVE_NAME=world`,
    `GENERATE_NEW_SAVE=true`, // no-op once world.zip exists
    `LOAD_LATEST_SAVE=true`, // resume the newest (auto)save on later boots
    `PORT=${ports.game}`,
    `RCON_PORT=${ports.rcon}`,
  ];
  if (input.map !== "FactorioDefault") factorioEnv.push(`PRESET=${input.map}`);
  for (const def of input.catalog.settings) {
    if (!FACTORIO_ENV_KEYS.has(def.key)) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    factorioEnv.push(`${def.key}=${typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw)}`);
  }

  const binds = [`${HostPaths.instanceRoot(input.serverId)}/data:${FACTORIO_DATA_DIR}`];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.FACTORIO],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: factorioEnv,
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
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/**
 * Merge Palisade's first-class fields + catalog keys into Factorio's
 * server-settings.json, preserving everything else (the image seeds the full
 * example file; users may hand-tune other keys). Dotted catalog keys
 * ("visibility.public") nest one level. `existing` is the current file text or
 * null before the first boot.
 */
export function patchFactorioSettings(
  existing: string | null,
  input: {
    sessionName: string;
    serverPassword: string;
    maxPlayers: number;
    catalog: SettingsCatalog;
    config: ServerConfigValues;
  },
): string {
  let doc: Record<string, unknown>;
  try {
    doc = existing ? (JSON.parse(existing) as Record<string, unknown>) : {};
  } catch {
    doc = {};
  }
  doc.name = input.sessionName;
  doc.game_password = input.serverPassword;
  doc.max_players = Math.max(0, Math.min(input.maxPlayers, 65535));
  for (const def of input.catalog.settings) {
    if (FACTORIO_ENV_KEYS.has(def.key)) continue; // image env vars, not settings keys
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null) continue;
    const dot = def.key.indexOf(".");
    if (dot > 0) {
      const parentKey = def.key.slice(0, dot);
      const child = def.key.slice(dot + 1);
      const parent = (doc[parentKey] ??= {}) as Record<string, unknown>;
      parent[child] = raw;
    } else {
      doc[def.emitAs ?? def.key] = raw;
    }
  }
  return JSON.stringify(doc, null, 2);
}

/** The repurposed map field -> Rust's RUST_SERVER_WORLDSIZE. */
const RUST_WORLD_SIZES: Record<string, number> = {
  RustSmall: 2000,
  RustMedium: 3000,
  RustLarge: 4500,
};

/**
 * Rust — drive the didstopia image. SteamCMD installs/updates the ~12 GB server
 * on boot into the single /steamcmd/rust bind (identity "docker" holds the map
 * save + cfg). RCON runs in LEGACY Source mode (RUST_RCON_WEB=0) so the existing
 * RCON stack speaks it; the Steam query (A2S) answers on 28016/udp while RCON
 * shares the number on TCP. This image wants booleans as "1"/"0".
 */
function buildRustSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const rustEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `RUST_SERVER_NAME=${input.sessionName}`,
    `RUST_SERVER_IDENTITY=docker`,
    `RUST_SERVER_PORT=${ports.game}`,
    `RUST_SERVER_QUERYPORT=${ports.query}`,
    `RUST_RCON_WEB=0`, // legacy Source RCON — our stack speaks it
    `RUST_RCON_PORT=${ports.rcon}`,
    `RUST_RCON_PASSWORD=${input.adminPassword}`,
    `RUST_APP_PORT=${ports.rawSocket}`, // Rust+ companion
    `RUST_SERVER_MAXPLAYERS=${input.maxPlayers}`,
    `RUST_SERVER_WORLDSIZE=${RUST_WORLD_SIZES[input.map] ?? 3000}`,
  ];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    rustEnv.push(`${def.emitAs ?? def.key}=${typeof raw === "boolean" ? (raw ? "1" : "0") : String(raw)}`);
  }

  const binds = [`${HostPaths.instanceRoot(input.serverId)}/data:${RUST_DATA_DIR}`];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.RUST],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: rustEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "udp")]: {},
            [portKey(ports.query, "udp")]: {},
            [portKey(ports.rcon, "tcp")]: {},
            [portKey(ports.rawSocket, "tcp")]: {},
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
              [portKey(ports.rawSocket, "tcp")]: [{ HostPort: String(ports.rawSocket) }],
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
 * BeamMP (BeamNG.drive multiplayer) — drive the rouhim image. The server binary
 * is baked in and fully env-driven; it's a lightweight relay (client-side
 * physics). The map field carries the vanilla LEVEL name (expanded to BeamNG's
 * /levels/<name>/info.json path); the MANDATORY beammp.com AuthKey rides the
 * admin-password field. Client-mod zips + server Lua plugins persist via binds.
 * NO RCON/query; one port, TCP AND UDP.
 */
function buildBeammpSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const beammpEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `BEAMMP_NAME=${input.sessionName}`,
    `BEAMMP_AUTH_KEY=${input.adminPassword}`,
    `BEAMMP_PORT=${ports.game}`,
    `BEAMMP_MAX_PLAYERS=${input.maxPlayers}`,
    `BEAMMP_MAP=/levels/${input.map}/info.json`,
  ];
  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    beammpEnv.push(`${def.emitAs ?? def.key}=${typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw)}`);
  }

  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [
    `${root}/mods-client:${BEAMMP_CLIENT_MODS_DIR}`, // map/vehicle zips sent to joiners
    `${root}/mods-server:${BEAMMP_SERVER_MODS_DIR}`, // server-side Lua plugins
  ];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.BEAMMP],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: beammpEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "tcp")]: {},
            [portKey(ports.game, "udp")]: {},
          },
        }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: {
              [portKey(ports.game, "tcp")]: [{ HostPort: String(ports.game) }],
              [portKey(ports.game, "udp")]: [{ HostPort: String(ports.game) }],
            },
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** The repurposed map field -> Terraria's -autocreate world size (1/2/3). */
const TERRARIA_WORLD_SIZES: Record<string, number> = {
  TerrariaSmall: 1,
  TerrariaMedium: 2,
  TerrariaLarge: 3,
};

/**
 * Terraria — drive the ryshe TShock image. TShock is baked in (nothing installs
 * on boot); the entrypoint passes container args through to TShock.Server, and
 * WORLD_FILENAME + -autocreate make it create-or-load the world. TShock's own
 * settings live in config.json INSIDE the worlds bind (CONFIGPATH), rendered by
 * patchTShockConfig before each start; its REST API (published on the rcon slot,
 * LAN-only) powers player counts. The in-game console is stdin-only (hidden).
 */
function buildTerrariaSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const args = [
    "-autocreate",
    String(TERRARIA_WORLD_SIZES[input.map] ?? 2),
    "-worldname",
    input.sessionName,
  ];
  for (const def of input.catalog.settings) {
    const flag = TERRARIA_CLI_KEYS[def.key];
    if (!flag) continue;
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    args.push(flag, String(raw));
  }

  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [
    `${root}/worlds:${TERRARIA_WORLDS_DIR}`, // world + TShock config.json
    `${root}/plugins:${TERRARIA_PLUGINS_DIR}`,
    `${root}/logs:${TERRARIA_LOGS_DIR}`,
  ];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.TERRARIA],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: [`TZ=${input.timezone || env.TZ}`, `WORLD_FILENAME=world.wld`],
    Cmd: args,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : {
          ExposedPorts: {
            [portKey(ports.game, "tcp")]: {},
            [portKey(ports.rcon, "tcp")]: {}, // TShock REST (player counts)
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

/**
 * Merge Palisade's first-class fields + catalog keys into TShock's config.json
 * (Settings object), preserving whatever else TShock has written there — it
 * rewrites the file with its full defaults on every boot. `existing` is the
 * current file text or null on first boot. The REST API is enabled exactly when
 * an admin token is set; the token doubles as the API credential.
 */
export function patchTShockConfig(
  existing: string | null,
  input: {
    sessionName: string;
    serverPassword: string;
    adminPassword: string;
    maxPlayers: number;
    gamePort: number;
    restPort: number;
    catalog: SettingsCatalog;
    config: ServerConfigValues;
  },
): string {
  let doc: { Settings?: Record<string, unknown> };
  try {
    doc = existing ? (JSON.parse(existing) as typeof doc) : {};
  } catch {
    doc = {}; // corrupt file — TShock refills defaults around our keys
  }
  const settings = (doc.Settings ??= {});
  settings.ServerName = input.sessionName;
  settings.ServerPassword = input.serverPassword;
  settings.MaxSlots = Math.min(Math.max(input.maxPlayers, 1), 255);
  settings.ServerPort = input.gamePort;
  settings.RestApiEnabled = Boolean(input.adminPassword);
  settings.RestApiPort = input.restPort;
  settings.ApplicationRestTokens = input.adminPassword
    ? { [input.adminPassword]: { Username: "palisade", UserGroupName: "superadmin" } }
    : {};
  for (const def of input.catalog.settings) {
    if (TERRARIA_CLI_KEYS[def.key]) continue; // launch args, not config keys
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null) continue;
    settings[def.emitAs ?? def.key] = raw;
  }
  return JSON.stringify(doc, null, 2);
}

/** The repurposed map field -> Core Keeper's WORLD_MODE numeric value. */
const CORE_KEEPER_WORLD_MODES: Record<string, number> = {
  CKNormal: 0,
  CKHard: 1,
  CKCreative: 2,
  CKCasual: 4,
};

/**
 * Core Keeper: drive the escaping image via env vars. The server runs in the
 * game's default STEAM RELAY mode — no ports are bound, published, or forwarded;
 * players join with the secret Game ID the server writes to GameID.txt in the
 * files bind (surfaced by the manager's join-info endpoint). The image installs
 * app 1963720 via SteamCMD on boot and runs as PUID/PGID. NO RCON.
 */
function buildCoreKeeperSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();

  const ckEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `PUID=${env.PUID}`,
    `PGID=${env.PGID}`,
    `WORLD_NAME=${input.sessionName}`,
    `MAX_PLAYERS=${Math.min(Math.max(input.maxPlayers, 1), 20)}`,
    `WORLD_MODE=${CORE_KEEPER_WORLD_MODES[input.map] ?? 0}`,
    ...coreKeeperCatalogEnv(input),
  ];

  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [
    `${root}/files:${CORE_KEEPER_FILES_DIR}`, // game install + GameID.txt
    `${root}/data:${CORE_KEEPER_DATA_DIR}`, // world saves
  ];

  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[Game.CORE_KEEPER],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: ckEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    HostConfig: {
      Binds: binds,
      ...(hostNet ? { NetworkMode: "host" } : {}),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    // Relay mode needs no inbound ports; on the bridge the container still joins
    // ark-net for consistency (harmless — nothing connects to it).
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** Core Keeper settings -> escaping env vars. Booleans become true/false; EMPTY
 *  values are dropped — critical for SEASON, which must be unset for real-date
 *  seasons. */
function coreKeeperCatalogEnv(input: RuntimeSpecInput): string[] {
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
 * American Truck Simulator / Euro Truck Simulator 2 — same ich777 SteamCMD wrapper
 * as LiF:YO, but the dedicated servers are NATIVE Linux and the images seed a
 * default server_packages world export + server_config.sii into the save dir on
 * first boot (normally the awkward part: exporting them from a game client). All
 * settings live in server_config.sii, patched by patchAtsServerConfig before each
 * start. NO RCON. The two games differ only in app id, image tag, and save dir.
 */
function buildAtsSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;

  const atsEnv = [
    `TZ=${input.timezone || env.TZ}`,
    // Pinnable via the STEAM_BRANCH setting (default "public") → a specific game version.
    `GAME_ID=${ich777GameId(input.game === Game.ATS ? 2239530 : 1948160, input.config.values?.["STEAM_BRANCH"])}`,
    `GAME_PARAMS=`,
    `UID=${env.PUID}`,
    `GID=${env.PGID}`,
    `VALIDATE=`,
  ];

  const root = HostPaths.instanceRoot(input.serverId);
  const binds = [
    `${root}/steamcmd:${LIF_STEAMCMD_DIR}`,
    `${root}/serverfiles:${LIF_SERVERFILES_DIR}`,
  ];

  const udpPorts = [ports.game, ports.query]; // 27015 connection + 27016 query
  const hostNet = env.GAME_HOST_NETWORK;
  return {
    name: containerName(input.serverId, input.game, input.sessionName),
    Image: IMAGES[input.game],
    Hostname: containerName(input.serverId, input.game, input.sessionName),
    Env: atsEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet
      ? {}
      : { ExposedPorts: Object.fromEntries(udpPorts.map((p) => [portKey(p, "udp"), {}])) }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: Object.fromEntries(
              udpPorts.map((p) => [portKey(p, "udp"), [{ HostPort: String(p) }]]),
            ),
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/**
 * OpenTTD (ich777). Env-light: the image downloads OpenTTD on first start and reads
 * server config from the three cfg files the config-writer renders under
 * serverfiles/.config/openttd. The whole instance dir binds to the image's DATA_DIR.
 * The game port carries both TCP (clients) and UDP (server-browser query).
 */
function buildOpenttdSpec(input: RuntimeSpecInput): Docker.ContainerCreateOptions {
  const env = loadEnv();
  const { ports } = input;
  const name = containerName(input.serverId, input.game, input.sessionName);

  const openttdEnv = [
    `TZ=${input.timezone || env.TZ}`,
    `GAME_PORT=${ports.game}`,
    `GAME_PARAMS=`,
    // Pinnable game version (default "latest") — set via the settings dropdown.
    `GAME_VERSION=${gameVersionValue(input.config.values?.["GAME_VERSION"], "latest")}`,
    `GFX_PK_V=latest`,
    // Skip the gotty web console — it hard-codes host:8080 under host networking, a
    // common conflict. OpenTTD admins use the in-game console (rcon_password).
    `ENABLE_WEBCONSOLE=false`,
    `UID=${env.PUID}`,
    `GID=${env.PGID}`,
  ];

  const binds = [`${HostPaths.instanceRoot(input.serverId)}:${OPENTTD_DATA_DIR}`];
  const hostNet = env.GAME_HOST_NETWORK;
  const portEntries = [portKey(ports.game, "tcp"), portKey(ports.game, "udp")];
  return {
    name,
    Image: IMAGES[input.game],
    Hostname: name,
    Env: openttdEnv,
    Labels: serverLabels(input, env.PUBLIC_BASE_URL),
    ...(hostNet ? {} : { ExposedPorts: Object.fromEntries(portEntries.map((k) => [k, {}])) }),
    HostConfig: {
      Binds: binds,
      ...(hostNet
        ? { NetworkMode: "host" }
        : {
            PortBindings: Object.fromEntries(
              portEntries.map((k) => [k, [{ HostPort: String(ports.game) }]]),
            ),
          }),
      RestartPolicy: { Name: "no" }, // manager watchdog owns restarts
      Memory: input.ramLimitMb ? input.ramLimitMb * 1024 * 1024 : undefined,
      NanoCpus: input.cpuLimit ? Math.round(input.cpuLimit * 1e9) : undefined,
    },
    ...(hostNet ? {} : { NetworkingConfig: { EndpointsConfig: { [ARK_NETWORK]: {} } } }),
  };
}

/** The last line of Steam's PalServer.sh, optionally already carrying our preload. */
const PAL_LAUNCH_LINE =
  /^([ \t]*)(?:LD_PRELOAD=(?:"[^"]*"|\S+)[ \t]+)?("\$UE_PROJECT_ROOT\/Pal\/Binaries\/Linux\/PalServer-Linux-Shipping"[ \t]+Pal[ \t]+"\$@")[ \t]*$/m;

/**
 * Scope UE4SS's LD_PRELOAD to the game process by editing Steam's PalServer.sh
 * launcher, rather than setting LD_PRELOAD on the container.
 *
 * A container-wide LD_PRELOAD injects libUE4SS.so into EVERY process the image
 * spawns — bash, steamcmd, the rcon client — and UE4SS segfaults immediately in
 * anything that isn't the Unreal server (verified: `bash -c echo` exits 139).
 * The image launches the server via ./PalServer.sh, which lives in the instance
 * bind mount, so prefixing that one exec line preloads it exactly where it belongs.
 *
 * `preload` is relative to the install dir (e.g. Pal/Binaries/Linux/libUE4SS.so);
 * pass null to remove a previously-applied preload. Idempotent, and re-applied on
 * every start because a SteamCMD update rewrites PalServer.sh. Returns the script
 * unchanged (no throw) when the launch line isn't recognized — a future Steam
 * layout shouldn't brick the server, it should just start without mods.
 */
export function patchPalServerLauncher(script: string, preload: string | null): string {
  if (!PAL_LAUNCH_LINE.test(script)) return script;
  return script.replace(PAL_LAUNCH_LINE, (_m, indent: string, exec: string) =>
    preload ? `${indent}LD_PRELOAD="$UE_PROJECT_ROOT/${preload}" ${exec}` : `${indent}${exec}`,
  );
}

/**
 * Patch an ATS server_config.sii in place: first-class fields (lobby name, join
 * password, slots, ports) plus the catalog's attributes, preserving the unit
 * header and any unknown/future keys. SII scalars: strings quoted, bools
 * true/false, ints bare. Only existing keys are touched (a key the game
 * removed/renamed is skipped rather than corrupting the file).
 */
export function patchAtsServerConfig(
  sii: string,
  input: {
    sessionName: string;
    serverPassword: string;
    maxPlayers: number;
    gamePort: number;
    queryPort: number;
    catalog: SettingsCatalog;
    config: ServerConfigValues;
  },
): string {
  const set = (doc: string, key: string, rendered: string): string =>
    doc.replace(new RegExp(`(^\\s*${key}\\s*:\\s*).*$`, "m"), `$1${rendered}`);
  const str = (v: unknown): string => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  let doc = sii;
  doc = set(doc, "lobby_name", str(input.sessionName.slice(0, 63)));
  doc = set(doc, "password", str(input.serverPassword.slice(0, 63)));
  doc = set(doc, "max_players", String(Math.min(Math.max(input.maxPlayers, 1), 8)));
  doc = set(doc, "connection_dedicated_port", String(input.gamePort));
  doc = set(doc, "query_dedicated_port", String(input.queryPort));

  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    if (def.noEmit) continue; // e.g. STEAM_BRANCH → GAME_ID, not a server_config.sii key
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null) continue;
    const rendered =
      typeof raw === "boolean" ? (raw ? "true" : "false") : def.type === "string" ? str(raw) : String(raw);
    doc = set(doc, def.emitAs ?? def.key, rendered);
  }
  return doc;
}

/**
 * Patch a LiF:YO world_1.xml in place: first-class fields (name, join + GM
 * passwords, slots, port) plus the catalog's tags, preserving everything else in
 * the file (comments, judgementHour, unknown future tags). The LIF_SKILLCAP_*
 * catalog keys land in the nested <skillcap><group id=N> elements. Booleans emit
 * as 1/0; values are XML-escaped. Returns the patched document.
 */
export function patchLifWorldXml(
  xml: string,
  input: {
    sessionName: string;
    serverPassword: string;
    adminPassword: string;
    maxPlayers: number;
    gamePort: number;
    catalog: SettingsCatalog;
    config: ServerConfigValues;
  },
): string {
  const esc = (v: unknown): string =>
    String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const setTag = (doc: string, tag: string, value: unknown): string =>
    doc.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), `<${tag}>${esc(value)}</${tag}>`);

  let doc = xml;
  doc = setTag(doc, "name", input.sessionName.slice(0, 63));
  doc = setTag(doc, "password", input.serverPassword.slice(0, 32));
  doc = setTag(doc, "adminPassword", input.adminPassword.slice(0, 32));
  doc = setTag(doc, "maxPlayers", Math.min(Math.max(input.maxPlayers, 1), 64));
  doc = setTag(doc, "port", input.gamePort);

  for (const def of input.catalog.settings) {
    if (def.target !== SettingTarget.Env) continue;
    if (def.noEmit) continue; // e.g. STEAM_BRANCH → GAME_ID, not a world_1.xml tag
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    const value = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
    const groupId = LIF_SKILLCAP_GROUPS[def.key];
    if (groupId !== undefined) {
      doc = doc.replace(
        new RegExp(`(<group id="${groupId}" value=")[^"]*(")`),
        `$1${esc(value)}$2`,
      );
    } else {
      doc = setTag(doc, def.emitAs ?? def.key, value);
    }
  }
  return doc;
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
    if (def.noEmit) continue; // e.g. VERSION is a launch/branch env, not an XML property
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null) continue;
    props[def.emitAs ?? def.key] = typeof raw === "boolean" ? (raw ? "true" : "false") : (raw as string | number);
  }
  const lines = Object.entries(props).map(
    ([name, value]) => `  <property name="${name}" value="${esc(value)}"/>`,
  );
  return `<?xml version="1.0"?>\n<ServerSettings>\n${lines.join("\n")}\n</ServerSettings>\n`;
}

/**
 * OpenTTD splits its config across three files under .config/openttd/: openttd.cfg
 * (public settings), private.cfg (server name), secrets.cfg (passwords). We render all
 * three fresh each start — the ich777 image hard-kills OpenTTD on `docker stop`, so it
 * never persists its own config, making our render authoritative. Catalog settings carry
 * emitAs="<section>.<key>" to route into the right [section] of openttd.cfg.
 */
export function renderOpenttdConfig(input: {
  sessionName: string;
  serverPassword: string;
  adminPassword: string;
  maxPlayers: number;
  map: string; // landscape: temperate / arctic / tropic / toyland
  gamePort: number;
  adminPort: number;
  catalog: SettingsCatalog;
  config: ServerConfigValues;
}): { "openttd.cfg": string; "private.cfg": string; "secrets.cfg": string } {
  // openttd.cfg values are read to end-of-line, so a stray newline would corrupt the
  // file — strip control chars from any free-text value.
  const clean = (v: unknown) => String(v).replace(/[\r\n]/g, " ").trim();

  const sections: Record<string, Record<string, string | number>> = {
    network: {
      server_port: input.gamePort,
      server_admin_port: input.adminPort,
      max_clients: input.maxPlayers,
    },
    game_creation: { landscape: input.map },
    difficulty: {},
  };
  for (const def of input.catalog.settings) {
    if (def.noEmit) continue; // e.g. GAME_VERSION is passed via env, not a cfg key
    const raw = input.config.values?.[def.key] ?? def.default;
    if (raw === undefined || raw === null) continue;
    const [section, key] = (def.emitAs ?? `network.${def.key}`).split(".");
    if (!section || !key) continue;
    (sections[section] ??= {})[key] =
      typeof raw === "boolean" ? (raw ? "true" : "false") : (raw as string | number);
  }

  const renderIni = (secs: Record<string, Record<string, string | number>>) =>
    Object.entries(secs)
      .filter(([, kv]) => Object.keys(kv).length > 0)
      .map(
        ([name, kv]) =>
          `[${name}]\n` +
          Object.entries(kv)
            .map(([k, v]) => `${k} = ${v}`)
            .join("\n"),
      )
      .join("\n\n") + "\n";

  return {
    "openttd.cfg": renderIni(sections),
    "private.cfg": `[network]\nserver_name = ${clean(input.sessionName)}\n`,
    "secrets.cfg":
      `[network]\n` +
      `server_password = ${clean(input.serverPassword)}\n` +
      `rcon_password = ${clean(input.adminPassword)}\n` +
      `admin_password = ${clean(input.adminPassword)}\n`,
  };
}
