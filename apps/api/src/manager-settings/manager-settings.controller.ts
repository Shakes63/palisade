import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { ManagerSettingsService, SettingKeys } from "./manager-settings.service";
import { SchedulerService } from "../scheduler/scheduler.service";
import { IsRouterHost, IsTargetIp } from "../portforwards/router";
import { MinRole } from "../auth/min-role.decorator";
import { LOG_LEVELS, type LogLevel } from "@ark/shared";

export class UpdateSettingsBody {
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() curseForgeApiKey?: string;
  @IsOptional() @IsString() steamWebApiKey?: string;
  @IsOptional() @IsString() steamGridDbApiKey?: string;
  /** Palisade's own database snapshots. Game-server retention is per-server. */
  @IsOptional() @IsInt() @Min(1) @Max(500) managerBackupKeep?: number;
  @IsOptional() @IsBoolean() autoStopOnStart?: boolean;
  @IsOptional() @IsIn(LOG_LEVELS) logLevel?: LogLevel;
  // Host/runtime overrides. Null clears the override and hands the decision back to
  // the environment variable, so "unset" stays reachable from the UI.
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean() gameHostNetwork?: boolean | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean() autoCreateNetwork?: boolean | null;
  @IsOptional() @IsString() publicBaseUrl?: string;
  @IsOptional() @IsString() @MaxLength(255) connectHost?: string;
  @IsOptional() @IsString() hostDataDir?: string;
  @IsOptional() @IsRouterHost(() => "pfsense") pfsenseHost?: string;
  @IsOptional() @IsString() pfsenseApiKey?: string;
  @IsOptional() @IsTargetIp() pfsenseTargetIp?: string;
  @IsOptional() @IsIn(["pfsense", "unifi", "mikrotik"]) portForwardRouter?: "pfsense" | "unifi" | "mikrotik";
  @IsOptional() @IsRouterHost(() => "unifi") unifiHost?: string;
  @IsOptional() @IsString() unifiApiKey?: string;
  @IsOptional() @IsString() unifiSite?: string;
  @IsOptional() @IsTargetIp() unifiTargetIp?: string;
  @IsOptional() @IsRouterHost(() => "mikrotik") mikrotikHost?: string;
  @IsOptional() @IsString() mikrotikUser?: string;
  @IsOptional() @IsString() mikrotikPassword?: string;
  @IsOptional() @IsTargetIp() mikrotikTargetIp?: string;
  @IsOptional() @IsString() mikrotikWanInterface?: string;
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

  /** The address to hand players for the in-game connect field (GH #88). Readable
   *  by every role: the connect card is on the dashboard, not just Settings. */
  @MinRole("viewer")
  @Get("connect-host")
  async connectHost(): Promise<{ host: string | null }> {
    return { host: await this.settings.getConnectHost() };
  }

  /** The zone recurring schedules fire in (GH #87). Readable by every role: the
   *  Schedules tab is not admin-only. */
  @MinRole("viewer")
  @Get("timezone")
  async timezone(): Promise<{ timezone: string }> {
    return { timezone: await this.settings.getTimezone() };
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
    if (body.logLevel !== undefined) {
      await this.settings.set(SettingKeys.LogLevel, body.logLevel);
      await this.settings.applyLogLevel();
    }
    if (body.pfsenseHost !== undefined) await this.settings.set(SettingKeys.PfsenseHost, body.pfsenseHost.trim());
    if (body.pfsenseApiKey) await this.settings.set(SettingKeys.PfsenseApiKey, body.pfsenseApiKey);
    if (body.pfsenseTargetIp !== undefined)
      await this.settings.set(SettingKeys.PfsenseTargetIp, body.pfsenseTargetIp.trim());
    if (body.portForwardRouter !== undefined)
      await this.settings.set(SettingKeys.PortForwardRouter, body.portForwardRouter);
    if (body.unifiHost !== undefined) await this.settings.set(SettingKeys.UnifiHost, body.unifiHost.trim());
    if (body.unifiApiKey) await this.settings.set(SettingKeys.UnifiApiKey, body.unifiApiKey.trim());
    if (body.unifiSite !== undefined) await this.settings.set(SettingKeys.UnifiSite, body.unifiSite.trim());
    if (body.unifiTargetIp !== undefined)
      await this.settings.set(SettingKeys.UnifiTargetIp, body.unifiTargetIp.trim());
    if (body.mikrotikHost !== undefined) await this.settings.set(SettingKeys.MikrotikHost, body.mikrotikHost.trim());
    if (body.mikrotikUser !== undefined) await this.settings.set(SettingKeys.MikrotikUser, body.mikrotikUser.trim());
    if (body.mikrotikPassword) await this.settings.set(SettingKeys.MikrotikPassword, body.mikrotikPassword);
    if (body.mikrotikTargetIp !== undefined)
      await this.settings.set(SettingKeys.MikrotikTargetIp, body.mikrotikTargetIp.trim());
    if (body.mikrotikWanInterface !== undefined)
      await this.settings.set(SettingKeys.MikrotikWanInterface, body.mikrotikWanInterface.trim());

    // Host overrides. An empty string / null means "defer to the env var again",
    // which is stored as "" and read back as unset by the tri-state getters.
    if (body.gameHostNetwork !== undefined)
      await this.settings.set(SettingKeys.GameHostNetwork, boolOverride(body.gameHostNetwork));
    if (body.autoCreateNetwork !== undefined)
      await this.settings.set(SettingKeys.AutoCreateNetwork, boolOverride(body.autoCreateNetwork));
    if (body.publicBaseUrl !== undefined)
      await this.settings.set(SettingKeys.PublicBaseUrl, body.publicBaseUrl.trim());
    if (body.connectHost !== undefined)
      await this.settings.set(SettingKeys.ConnectHost, body.connectHost.trim());
    if (body.hostDataDir !== undefined) {
      await this.settings.set(SettingKeys.HostDataDir, body.hostDataDir.trim());
      // Takes effect for the next container created, without a restart (GH #29).
      await this.settings.applyHostOverrides();
    }
    return this.settings.publicView();
  }
}
