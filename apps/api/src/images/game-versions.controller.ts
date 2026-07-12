import { BadRequestException, Controller, Get, Param } from "@nestjs/common";
import { Game } from "@ark/shared";
import { GameVersionsService } from "./game-versions.service";

@Controller("games/:game/versions")
export class GameVersionsController {
  constructor(private readonly versions: GameVersionsService) {}

  /** Available GAME versions for a game ({ defaultValue, defaultLabel, options }).
   *  Empty options for games whose image has no version knob. */
  @Get()
  list(@Param("game") game: string) {
    if (!Object.values(Game).includes(game as Game)) {
      throw new BadRequestException(`Unknown game "${game}"`);
    }
    return this.versions.list(game as Game);
  }
}
