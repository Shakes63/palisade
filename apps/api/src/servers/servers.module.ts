import { Module } from "@nestjs/common";
import { ServersService } from "./servers.service";
import { ServerConfigWriter } from "./config-writer.service";
import { ServersController } from "./servers.controller";
import { StateMachineService } from "./state-machine.service";
import { HistoryService } from "./history.service";
import { RconModule } from "../rcon/rcon.module";
import { BackupsModule } from "../backups/backups.module";
import { PlayersModule } from "../players/players.module";

@Module({
  imports: [RconModule, BackupsModule, PlayersModule],
  controllers: [ServersController],
  providers: [ServersService, ServerConfigWriter, StateMachineService, HistoryService],
  exports: [ServersService, StateMachineService],
})
export class ServersModule {}
