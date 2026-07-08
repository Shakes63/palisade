import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { IsArray, IsBoolean, IsOptional, IsString } from "class-validator";

/** The slice of Express's Response we use (avoids a @types/express dependency). */
interface HeaderSettable {
  setHeader(name: string, value: string): void;
}
import type { CreateServerDto, UpdateServerDto } from "@ark/shared";
import { ServersService } from "./servers.service";
import { EventsService } from "../events/events.service";
import { CreateServerBody, UpdateServerBody } from "./servers.dto";

class CopyServerBody {
  @IsArray() @IsString({ each: true }) targetIds!: string[];
  @IsBoolean() settings!: boolean;
  @IsBoolean() mods!: boolean;
}

class StartBody {
  /** Skip the RAM guard and start anyway. */
  @IsOptional() @IsBoolean() force?: boolean;
  /** Stop this running server first (freeing its RAM), then start. */
  @IsOptional() @IsString() stopFirst?: string;
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

  /** Whole-machine stats (for the dashboard disk-space warning). Must also
   *  precede @Get(":id"). */
  @Get("host")
  host() {
    return this.servers.hostStats();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.servers.get(id);
  }

  @Get(":id/config")
  getConfig(@Param("id") id: string) {
    return this.servers.getConfig(id);
  }

  // Captured log/console for the current run (survives refresh + tab switches;
  // wiped on Start). Complete whether or not a tab was open during boot.
  @Get(":id/logs")
  logs(@Param("id") id: string) {
    return { log: this.servers.runLog(id) };
  }

  @Get(":id/console")
  console(@Param("id") id: string) {
    return { log: this.servers.runConsole(id) };
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

  /** Delete the server. ?wipe=0 keeps the on-disk game data + backups (default wipes). */
  @Delete(":id")
  remove(@Param("id") id: string, @Query("wipe") wipe?: string) {
    return this.servers.remove(id, { wipeFiles: wipe !== "0" && wipe !== "false" });
  }

  /** Stream the server's save data (worlds/configs, NOT the game install) as a
   *  tar.gz — offered in the delete dialog so data can be kept before wiping. */
  @Get(":id/download")
  async download(@Param("id") id: string, @Res({ passthrough: true }) res: HeaderSettable) {
    const { stream, filename } = await this.servers.downloadSaves(id);
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return new StreamableFile(stream);
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
  start(@Param("id") id: string, @Body() body: StartBody) {
    return this.servers.start(id, { force: body?.force, stopFirst: body?.stopFirst });
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
