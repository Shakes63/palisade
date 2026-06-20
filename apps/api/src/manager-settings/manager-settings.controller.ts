import { Body, Controller, Get, Patch } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { IsOptional, IsString } from "class-validator";
import { ManagerSettingsService, SettingKeys } from "./manager-settings.service";
import { SchedulerService } from "../scheduler/scheduler.service";

class UpdateSettingsBody {
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() curseForgeApiKey?: string;
  @IsOptional() @IsString() steamWebApiKey?: string;
}

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
    return this.settings.publicView();
  }
}
