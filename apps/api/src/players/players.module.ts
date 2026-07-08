import { Module } from "@nestjs/common";
import { RconModule } from "../rcon/rcon.module";
import { LogCaptureModule } from "../logs/log-capture.module";
import { AccessListsModule } from "../accesslists/accesslists.module";
import { PlayersService } from "./players.service";
import { SightingsService } from "./sightings.service";
import { PlayersController } from "./players.controller";

@Module({
  imports: [RconModule, LogCaptureModule, AccessListsModule],
  controllers: [PlayersController],
  providers: [PlayersService, SightingsService],
  exports: [PlayersService, SightingsService],
})
export class PlayersModule {}
