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
  /** Settings changed after the running container was created — a restart will
   *  apply them. The dashboard turns the Start button into Restart when set. */
  configDirty: boolean;
  playersOnline?: number | null;
  maxPlayers: number;
  modIds: number[];
  ramLimitMb?: number | null;
  cpuLimit?: number | null;
  createdAt: string;
  updatedAt: string;
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
