import { Module } from "@nestjs/common";
import { SchedulerService } from "./scheduler.service";
import { SchedulesController } from "./schedules.controller";
import { ServersModule } from "../servers/servers.module";
import { RconModule } from "../rcon/rcon.module";
import { BackupsModule } from "../backups/backups.module";
import { PlayersModule } from "../players/players.module";
import { UpdatesModule } from "../updates/updates.module";
import { ModUpdatesModule } from "../modupdates/modupdates.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [
    ServersModule,
    RconModule,
    BackupsModule,
    PlayersModule,
    UpdatesModule,
    ModUpdatesModule,
    AuthModule,
  ],
  controllers: [SchedulesController],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
