import { Game } from "./game";

/**
 * How a game's VERSION can (or can't) be pinned in Palisade — drives the UI so a
 * user is never misled about what changing the Docker image tag actually does.
 *
 * - "game-version": the game version is a setting (Settings tab) — the image tag
 *   only changes the management wrapper/runtime, not the game.
 * - "image-tag": the Docker image tag IS the game version (pick it in the image card).
 * - "none": the wrapper always installs the latest version from Steam on start; the
 *   game version can't be pinned. The image tag changes the wrapper only.
 */
export type VersionPinKind = "game-version" | "image-tag" | "none";

export const GAME_VERSION_PINNING: Record<Game, VersionPinKind> = {
  // Game version lives in the Settings tab (env/branch the wrapper reads).
  [Game.MINECRAFT]: "game-version", // VERSION (Mojang dropdown)
  [Game.BEDROCK]: "game-version", // VERSION (free-text)
  [Game.OPENTTD]: "game-version", // GAME_VERSION (GitHub dropdown)
  [Game.ENSHROUDED]: "game-version", // GAME_BRANCH (public/testing)
  [Game.SEVEN_DAYS]: "game-version", // VERSION (stable/experimental)
  [Game.SATISFACTORY]: "game-version", // STEAMBETA (experimental)
  [Game.VALHEIM]: "game-version", // PUBLIC_TEST
  [Game.PALWORLD]: "game-version", // INSTALL_BETA_INSIDER
  [Game.VRISING]: "game-version", // BRANCH (legacy)
  [Game.ATS]: "game-version", // STEAM_BRANCH → GAME_ID -beta
  [Game.ETS2]: "game-version", // STEAM_BRANCH → GAME_ID -beta
  [Game.LIF]: "game-version", // STEAM_BRANCH → GAME_ID -beta

  // The Docker image tag itself selects the game build.
  [Game.FACTORIO]: "image-tag", // factoriotools/factorio:<version>
  [Game.TERRARIA]: "image-tag", // ryshe/terraria:<tshock-version>

  // SteamCMD wrappers that always install the latest — version not pinnable.
  [Game.ASA]: "none",
  [Game.ASE]: "none",
  [Game.CONAN]: "none",
  [Game.PALWORLD_WINE]: "none",
  [Game.ICARUS]: "none",
  [Game.ZOMBOID]: "none", // STEAMAPPBRANCH is build-time only in the image
  [Game.SOTF]: "none",
  [Game.CORE_KEEPER]: "none",
  [Game.RUST]: "none",
  [Game.BEAMMP]: "none",
  [Game.CS2]: "none", // the image runs a SteamCMD update on every start — restart = update
  [Game.DST]: "none", // jamesits updates the server on start
  [Game.DRAGONWILDS]: "none", // the image runs SteamCMD on every start
};
