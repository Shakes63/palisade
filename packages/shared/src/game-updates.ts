/**
 * How a game's FILES get updated — the counterpart to GAME_VERSION_PINNING (which
 * is about pinning a version, not refreshing one). Palisade never runs SteamCMD
 * itself: the game image does, on container start. So "update the game" always
 * means "make the next start fetch the new build", and this says what that takes.
 *
 * - "on-start": the image runs SteamCMD (or its own downloader) on every boot, so
 *   a restart IS the update. Most wrappers work this way.
 * - "on-request": the manager disables the image's updater (it would fight the
 *   manager's own restart/backup loops), so an update has to be armed for exactly
 *   one boot — see ONE_SHOT_UPDATE_ENV.
 * - "image": the game files are baked into the Docker image, so updating means
 *   pulling a newer image and recreating the container — see IMAGE_BAKED_GAMES.
 *
 * The mode is DERIVED server-side from those two tables rather than hand-listed
 * per game (a parallel table drifts the moment either one changes) and reaches the
 * UI on GameBuildStatus.mode.
 */
export type GameUpdateMode = "on-start" | "on-request" | "image";
