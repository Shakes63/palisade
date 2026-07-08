import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { IsIn, IsString } from "class-validator";
import { SightingsService, type PlayerAction } from "./sightings.service";

class PlayerActionBody {
  @IsString() name!: string;
  @IsIn(["kick", "ban", "whitelist", "admin"]) action!: PlayerAction;
}

@Controller("servers/:id/players")
export class PlayersController {
  constructor(private readonly sightings: SightingsService) {}

  /** Everyone seen on this server (RCON polls + join-log parsing), newest first. */
  @Get()
  view(@Param("id") id: string) {
    return this.sightings.view(id);
  }

  /** Kick / ban / whitelist / make-admin a seen player, game-appropriately. */
  @Post("action")
  act(@Param("id") id: string, @Body() body: PlayerActionBody) {
    return this.sightings.act(id, body.name, body.action);
  }
}
