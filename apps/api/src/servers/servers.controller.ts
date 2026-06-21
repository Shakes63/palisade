import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { IsArray, IsBoolean, IsString } from "class-validator";
import type { CreateServerDto, UpdateServerDto } from "@ark/shared";
import { ServersService } from "./servers.service";
import { EventsService } from "../events/events.service";
import { CreateServerBody, UpdateServerBody } from "./servers.dto";

class CopyServerBody {
  @IsArray() @IsString({ each: true }) targetIds!: string[];
  @IsBoolean() settings!: boolean;
  @IsBoolean() mods!: boolean;
}

@Controller("servers")
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly events: EventsService,
  ) {}

  @Get()
  list() {
    return this.servers.list();
  }

  // Must precede @Get(":id") so "/servers/stats" isn't captured as id="stats".
  @Get("stats")
  statsAll() {
    return this.servers.statsAll();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.servers.get(id);
  }

  @Get(":id/config")
  getConfig(@Param("id") id: string) {
    return this.servers.getConfig(id);
  }

  @Get(":id/logs")
  async logs(@Param("id") id: string, @Query("tail") tail?: string) {
    const n = Math.min(2000, Math.max(1, Number(tail) || 200));
    return { log: await this.servers.tailLog(id, n) };
  }

  @Get(":id/stats")
  stats(@Param("id") id: string) {
    return this.servers.stats(id);
  }

  @Get(":id/events")
  events_(@Param("id") id: string) {
    return this.events.recent(id);
  }

  @Post()
  create(@Body() body: CreateServerBody) {
    return this.servers.create(body as CreateServerDto);
  }

  @Post("import")
  import(@Body() body: CreateServerBody) {
    return this.servers.importExisting(body as CreateServerDto, body.savedSourcePath);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateServerBody) {
    return this.servers.update(id, body as UpdateServerDto);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.servers.remove(id);
  }

  /** Copy this server's settings/mods onto the given (same-game) targets. */
  @Post(":id/copy")
  copy(@Param("id") id: string, @Body() body: CopyServerBody) {
    return this.servers.copyTo(id, body);
  }

  @Post(":id/install")
  install(@Param("id") id: string) {
    return this.servers.installGame(id);
  }

  @Post(":id/start")
  start(@Param("id") id: string) {
    return this.servers.start(id);
  }

  @Post(":id/stop")
  stop(@Param("id") id: string) {
    return this.servers.stop(id);
  }

  @Post(":id/restart")
  restart(@Param("id") id: string) {
    return this.servers.restart(id);
  }
}
