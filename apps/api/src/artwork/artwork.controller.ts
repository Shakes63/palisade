import { BadRequestException, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { Game, type ArtworkKind } from "@ark/shared";
import { ArtworkService } from "./artwork.service";
import { MinRole } from "../auth/min-role.decorator";

const KINDS: ArtworkKind[] = ["grid", "hero", "logo", "icon"];

@Controller("artwork")
export class ArtworkController {
  constructor(private readonly artwork: ArtworkService) {}

  /** Per-game art URL map for the web UI (any role — it's decoration). */
  @Get()
  all() {
    return this.artwork.getAll();
  }

  /** Candidate assets of one kind for the per-server picker. */
  @Get("options/:game")
  options(@Param("game") game: string, @Query("kind") kind?: string) {
    if (!Object.values(Game).includes(game as Game)) throw new BadRequestException("Unknown game");
    if (!kind || !KINDS.includes(kind as ArtworkKind)) {
      throw new BadRequestException(`kind must be one of: ${KINDS.join(", ")}`);
    }
    return this.artwork.options(game as Game, kind as ArtworkKind);
  }

  /** Force a full fetch (used by the settings "fetch artwork" button). */
  @MinRole("admin")
  @Post("refresh")
  refresh() {
    return this.artwork.refresh();
  }
}
