import type { Game, PortSet } from "./game";
import type { ServerState } from "./server-state";
import type { ServerConfigValues } from "./settings-catalog";

/** Public (no secrets) view of a server instance. */
export interface ServerSummary {
  id: string;
  name: string;
  game: Game;
  map: string;
  state: ServerState;
  clusterId?: string | null;
  ports: PortSet;
  installedBuildId?: string | null;
  updateAvailable: boolean;
  /** One or more installed mods have a newer version available (Valheim/Thunderstore
   *  or a pinned Minecraft/CurseForge modpack). Refreshed by the mod-update poller. */
  modUpdateAvailable: boolean;
  /** Advanced: pinned game-image tag, or null to use the shipped default. */
  imageTag?: string | null;
  /** When the server is Crashed, why its container died: exit code (or OOM) plus a
   *  log tail — or the launch error for a start that never got a container. Null
   *  otherwise. Lets the UI explain a crash (e.g. a pinned image that won't boot). */
  crashReason?: string | null;
  /** The game's server image is already pulled locally — "Install" (an image
   *  pull) would be a no-op, so the UI disables it. Game files install on Start. */
  imageReady: boolean;
  /** Settings changed after the running container was created — a restart will
   *  apply them. The dashboard turns the Start button into Restart when set. */
  configDirty: boolean;
  /** Plain-text server join password (the ServerPassword setting), or null. Used
   *  by the UI to build the connect command and tailor the browser-filter hint.
   *  Plain text is intentional (see ServerPassword in the catalog). */
  joinPassword?: string | null;
  /** Whether an admin password (which also enables RCON) is set. The value itself
   *  is never returned — only whether one exists, so the UI can show its status. */
  hasAdminPassword?: boolean;
  playersOnline?: number | null;
  maxPlayers: number;
  modIds: number[];
  ramLimitMb?: number | null;
  cpuLimit?: number | null;
  /** Per-server SteamGridDB art override (each field null = use the game default). */
  artwork?: GameArtwork | null;
  createdAt: string;
  updatedAt: string;
}

/** One selectable SteamGridDB asset for the per-server artwork picker. */
export interface ArtworkOption {
  url: string;
  thumb: string;
}

/** Art asset kinds a server can override. */
export type ArtworkKind = "grid" | "hero" | "logo" | "icon";

/** Live resource usage for a server. CPU/memory are null unless the container is
 *  up (Starting counts — boot is the heaviest period); disk (the on-disk instance
 *  size) is null until the first measurement lands. */
export interface ServerStats {
  /** True when the container is up and reporting CPU/memory. */
  live: boolean;
  cpuPercent: number | null;
  memUsedMb: number | null;
  memLimitMb: number | null;
  diskUsedMb: number | null;
  /** Live player count (A2S / RakNet / RCON, game-appropriate); null when unknown. */
  playersOnline: number | null;
  playersMax: number | null;
}

/** Batch stats keyed by server id (for the servers list). */
export type ServerStatsById = ServerStats & { id: string };

/** A currently-running server + its live RAM, shown in the start-guard dialog. */
export interface RunningServerRam {
  id: string;
  name: string;
  game: Game;
  ramUsedMb: number | null;
  /** Who'd be interrupted by stopping this server (null = unknown). */
  playersOnline: number | null;
}

/** 409 body when a start would exceed free host RAM. The UI offers to stop one of
 *  the running servers (and then auto-start the original) or to start anyway. */
export interface InsufficientRamInfo {
  code: "INSUFFICIENT_RAM";
  needMb: number;
  availableMb: number;
  totalMb: number;
  running: RunningServerRam[];
  /** Whether the "auto-stop to free RAM" setting is on — decides if the start guard
   *  offers to back up + stop a running server (a swap) or just warns. */
  autoStop: boolean;
}

/** Whole-machine resource usage (the Unraid host), for context next to a server. */
export interface HostStats {
  cpuPercent: number | null;
  memUsedMb: number;
  memTotalMb: number;
  diskUsedMb: number;
  diskFreeMb: number;
  diskTotalMb: number;
}

/** A single server's stats plus the host totals (the detail endpoint). */
export type ServerStatsDetail = ServerStats & { host: HostStats };

/** One available image tag from the registry. */
export interface ImageTag {
  name: string;
  /** Last-pushed time (Docker Hub only; GHCR doesn't expose it cheaply). */
  updatedAt?: string | null;
}

/** Available image tags for a game, for the advanced version picker. */
export interface ImageTagsResult {
  repo: string; // e.g. "ich777/openttdserver"
  defaultTag: string; // the tag Palisade ships with
  tags: ImageTag[]; // newest-first where the registry provides ordering
}

export interface CreateServerDto {
  name: string;
  game: Game;
  map: string;
  maxPlayers?: number;
  clusterId?: string | null;
  modIds?: number[];
  ramLimitMb?: number;
  cpuLimit?: number;
  /** Passwords are accepted here and stored encrypted; never returned. */
  adminPassword?: string;
  serverPassword?: string;
  spectatorPassword?: string;
  config?: ServerConfigValues;
  /** Advanced: pin the game image to a specific tag instead of the shipped default
   *  (null clears the pin). Applied on the next start (pull + recreate). */
  imageTag?: string | null;
}

export type UpdateServerDto = Partial<CreateServerDto> & {
  /** Editable only while the server is stopped. Sibling ports (raw socket, and the
   *  query port on games where it's game-port-derived) follow automatically. */
  gamePort?: number;
  queryPort?: number;
  rconPort?: number;
};

/** A user-defined settings preset, persisted in the manager DB and reusable
 *  across servers of the same game (alongside the built-in SETTINGS_PRESETS). */
export interface CustomPreset {
  id: string;
  name: string;
  description?: string;
  game: Game;
  /** catalog key -> value, merged over current settings when applied. */
  values: Record<string, unknown>;
  createdAt: string;
}

export interface CreateCustomPresetDto {
  name: string;
  description?: string;
  game: Game;
  values: Record<string, unknown>;
}

export interface RconCommandDto {
  command: string;
}

export interface ScheduleDto {
  id?: string;
  serverId: string;
  name: string;
  cron: string; // standard 5-field cron
  action: "restart" | "update" | "backup" | "stop" | "start";
  /** Minutes of in-game warning countdown before a disruptive action. */
  warnMinutes?: number;
  enabled: boolean;
}

export interface LoginDto {
  username: string;
  password: string;
}

export interface FirstRunDto {
  username: string;
  password: string;
  dataDir?: string;
  curseForgeApiKey?: string;
  steamWebApiKey?: string;
  timezone?: string;
}

/** Topics broadcast over the realtime gateway. */
export enum RealtimeTopic {
  ServerState = "server.state",
  ServerLog = "server.log",
  InstallProgress = "install.progress",
  RconOutput = "rcon.output",
  Event = "event",
}

export interface RealtimeMessage<T = unknown> {
  topic: RealtimeTopic;
  serverId?: string;
  payload: T;
  at: string;
}

/** User roles, least → most privileged. Viewer = read-only, operator = day-to-day
 *  server ops (start/stop/console/backups/mods/schedules), admin = everything
 *  (settings, users, notifications, replication, deletes). */
export type Role = "viewer" | "operator" | "admin";
export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
export const ROLES: Role[] = ["viewer", "operator", "admin"];

/** Per-game artwork resolved from SteamGridDB (all URLs on their CDN; null = none found). */
export interface GameArtwork {
  /** 600x900 portrait cover ("grid"). */
  grid: string | null;
  /** Wide banner ("hero", e.g. 1920x620). */
  hero: string | null;
  /** Transparent title logo. */
  logo: string | null;
  /** Square icon. */
  icon: string | null;
}
