import { Module } from "@nestjs/common";
import { RconModule } from "../rcon/rcon.module";
import { PlayersService } from "./players.service";

@Module({
  imports: [RconModule],
  providers: [PlayersService],
  exports: [PlayersService],
})
export class PlayersModule {}
