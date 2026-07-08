import { Module } from "@nestjs/common";
import { SchedulerService } from "./scheduler.service";
import { SchedulesController } from "./schedules.controller";
import { ServersModule } from "../servers/servers.module";
import { RconModule } from "../rcon/rcon.module";
import { BackupsModule } from "../backups/backups.module";
import { PlayersModule } from "../players/players.module";

@Module({
  imports: [ServersModule, RconModule, BackupsModule, PlayersModule],
  controllers: [SchedulesController],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
