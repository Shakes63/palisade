import { Game } from "@ark/shared";

/** Shared Docker network the manager and all game containers join (for RCON). */
export const ARK_NETWORK = "ark-net";

/** Container-name prefix per game, so e.g. Conan containers aren't named "ark-…".
 *  Cosmetic only — containers are matched by the `ark.serverId` label. */
const CONTAINER_PREFIX: Record<Game, string> = {
  [Game.ASA]: "ark",
  [Game.ASE]: "ark",
  [Game.CONAN]: "conan",
  [Game.PALWORLD]: "palworld",
  [Game.MINECRAFT]: "minecraft",
  [Game.ICARUS]: "icarus",
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "server";
}

/**
 * Docker container name. Given the server name it's human-readable (so it's
 * recognizable on the Unraid Docker dashboard), suffixed with a slice of the id to
 * keep it unique across same-named servers; without a name it falls back to the
 * stable id form. The prefix follows the game (ark/conan). Containers are always
 * matched by the `ark.serverId` label, so the name is purely cosmetic and may
 * change freely. Also the RCON host on the bridge.
 */
export function containerName(serverId: string, game: Game, name?: string): string {
  const prefix = CONTAINER_PREFIX[game];
  return name ? `${prefix}-${slug(name)}-${serverId.slice(-6)}` : `${prefix}-${serverId}`;
}
