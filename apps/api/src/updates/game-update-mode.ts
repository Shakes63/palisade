import { Game, type GameUpdateMode } from "@ark/shared";
import { IMAGE_BAKED_GAMES } from "../common/images";
import { ONE_SHOT_UPDATE_ENV } from "../servers/runtime-spec";

/**
 * What it takes to move one game to a newer build, derived from the two tables that
 * already decide it: the game is baked into its image, or the manager disables the
 * image's own updater and has to arm it for a single boot, or the image just updates
 * every time it boots. Derived, not declared — a hand-maintained third table would
 * silently disagree with the behaviour the other two produce.
 */
export function gameUpdateMode(game: Game): GameUpdateMode {
  if (IMAGE_BAKED_GAMES.has(game)) return "image";
  return ONE_SHOT_UPDATE_ENV[game] ? "on-request" : "on-start";
}
