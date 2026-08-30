import { Game } from "@ark/shared";

/**
 * Shared Docker network the manager and all game containers join (for RCON).
 *
 * The name is load-bearing on Unraid, which is why it is not "ark-net" any more.
 * For a manager container on a custom (macvlan/ipvlan) network, Unraid derives the
 * WebUI button's address from `reset($ct['Networks'])` — the FIRST entry of the
 * container's network map — and the Docker API returns that map sorted by name. So
 * "ark-net" sorted ahead of "br0"/"bond0"/"eth0" and the WebUI button pointed at the
 * bridge IP instead of the LAN one the moment Palisade attached itself (GH #31).
 * Anything sorting after those interface names, like this, picks the right IP by
 * itself. SHARED_NETWORK overrides it if a host manages to sort even later.
 */
export const DEFAULT_SHARED_NETWORK = "palisade-net";

/** The pre-1.11 network name. Still honoured for installs that have servers on it —
 *  see common/shared-network.ts for how the two coexist during the migration. */
export const LEGACY_NETWORK = "ark-net";

/** Container-name prefix per game, so e.g. Conan containers aren't named "ark-…".
 *  Cosmetic only — containers are matched by the `ark.serverId` label. */
const CONTAINER_PREFIX: Record<Game, string> = {
  [Game.ASA]: "ark",
  [Game.ASE]: "ark",
  [Game.CONAN]: "conan",
  [Game.PALWORLD]: "palworld",
  [Game.PALWORLD_WINE]: "palworld-wine",
  [Game.MINECRAFT]: "minecraft",
  [Game.ICARUS]: "icarus",
  [Game.BEDROCK]: "bedrock",
  [Game.VALHEIM]: "valheim",
  [Game.SEVEN_DAYS]: "7dtd",
  [Game.ENSHROUDED]: "enshrouded",
  [Game.ZOMBOID]: "zomboid",
  [Game.VRISING]: "vrising",
  [Game.SOTF]: "sotf",
  [Game.SATISFACTORY]: "satisfactory",
  [Game.LIF]: "lif",
  [Game.ATS]: "ats",
  [Game.ETS2]: "ets2",
  [Game.CORE_KEEPER]: "corekeeper",
  [Game.TERRARIA]: "terraria",
  [Game.FACTORIO]: "factorio",
  [Game.RUST]: "rust",
  [Game.BEAMMP]: "beammp",
  [Game.OPENTTD]: "openttd",
  [Game.CS2]: "cs2",
  [Game.DST]: "dst",
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
