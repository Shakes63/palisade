import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from "class-validator";
import { ManagerSettingsService, SettingKeys } from "./manager-settings.service";
import { SchedulerService } from "../scheduler/scheduler.service";
import { MinRole } from "../auth/min-role.decorator";

class UpdateSettingsBody {
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() curseForgeApiKey?: string;
  @IsOptional() @IsString() steamWebApiKey?: string;
  @IsOptional() @IsString() steamGridDbApiKey?: string;
  /** Palisade's own database snapshots. Game-server retention is per-server. */
  @IsOptional() @IsInt() @Min(1) @Max(500) managerBackupKeep?: number;
  @IsOptional() @IsBoolean() autoStopOnStart?: boolean;
  // Host/runtime overrides. Null clears the override and hands the decision back to
  // the environment variable, so "unset" stays reachable from the UI.
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean() gameHostNetwork?: boolean | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean() autoCreateNetwork?: boolean | null;
  @IsOptional() @IsString() publicBaseUrl?: string;
  @IsOptional() @IsString() hostDataDir?: string;
  @IsOptional() @IsString() pfsenseHost?: string;
  @IsOptional() @IsString() pfsenseApiKey?: string;
  @IsOptional() @IsString() pfsenseTargetIp?: string;
}

/** "" for null so the row exists but reads back as unset — the tri-state the
 *  getters rely on to let the environment variable win again. */
function boolOverride(v: boolean | null): string {
  return v === null ? "" : String(v);
}

// Even the "public" view exposes infrastructure config (pfSense host, data dir),
// and only the admin-only Settings page consumes it.
@MinRole("admin")
@Controller("settings")
export class ManagerSettingsController {
  constructor(
    private readonly settings: ManagerSettingsService,
    // Resolved lazily (strict:false) so we don't import SchedulerModule into the
    // global settings module — that would risk a circular init.
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Non-secret settings; secrets are reported only as present/absent. */
  @Get()
  view() {
    return this.settings.publicView();
  }

  @MinRole("admin")
  @Patch()
  async update(@Body() body: UpdateSettingsBody) {
    if (body.timezone) {
      await this.settings.set(SettingKeys.Timezone, body.timezone);
      // Re-register schedules so the new timezone takes effect immediately.
      await this.moduleRef.get(SchedulerService, { strict: false }).registerAll();
    }
    if (body.curseForgeApiKey)
      await this.settings.set(SettingKeys.CurseForgeApiKey, body.curseForgeApiKey);
    if (body.steamWebApiKey)
      await this.settings.set(SettingKeys.SteamWebApiKey, body.steamWebApiKey);
    if (body.steamGridDbApiKey)
      await this.settings.set(SettingKeys.SteamGridDbApiKey, body.steamGridDbApiKey);
    if (body.managerBackupKeep !== undefined)
      await this.settings.set(SettingKeys.ManagerBackupKeep, String(body.managerBackupKeep));
    if (body.autoStopOnStart !== undefined)
      await this.settings.set(SettingKeys.AutoStopOnStart, String(body.autoStopOnStart));
    if (body.pfsenseHost !== undefined) await this.settings.set(SettingKeys.PfsenseHost, body.pfsenseHost);
    if (body.pfsenseApiKey) await this.settings.set(SettingKeys.PfsenseApiKey, body.pfsenseApiKey);
    if (body.pfsenseTargetIp !== undefined)
      await this.settings.set(SettingKeys.PfsenseTargetIp, body.pfsenseTargetIp);

    // Host overrides. An empty string / null means "defer to the env var again",
    // which is stored as "" and read back as unset by the tri-state getters.
    if (body.gameHostNetwork !== undefined)
      await this.settings.set(SettingKeys.GameHostNetwork, boolOverride(body.gameHostNetwork));
    if (body.autoCreateNetwork !== undefined)
      await this.settings.set(SettingKeys.AutoCreateNetwork, boolOverride(body.autoCreateNetwork));
    if (body.publicBaseUrl !== undefined)
      await this.settings.set(SettingKeys.PublicBaseUrl, body.publicBaseUrl.trim());
    if (body.hostDataDir !== undefined) {
      await this.settings.set(SettingKeys.HostDataDir, body.hostDataDir.trim());
      // Takes effect for the next container created, without a restart (GH #29).
      await this.settings.applyHostOverrides();
    }
    return this.settings.publicView();
  }
}
