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
  createdAt: string;
  updatedAt: string;
}

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
}

/** Batch stats keyed by server id (for the servers list). */
export type ServerStatsById = ServerStats & { id: string };

/** A currently-running server + its live RAM, shown in the start-guard dialog. */
export interface RunningServerRam {
  id: string;
  name: string;
  game: Game;
  ramUsedMb: number | null;
}

/** 409 body when a start would exceed free host RAM. The UI offers to stop one of
 *  the running servers (and then auto-start the original) or to start anyway. */
export interface InsufficientRamInfo {
  code: "INSUFFICIENT_RAM";
  needMb: number;
  availableMb: number;
  totalMb: number;
  running: RunningServerRam[];
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
}

export type UpdateServerDto = Partial<CreateServerDto>;

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
