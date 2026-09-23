import { Game, GAME_LABELS } from "./game";

/** Only ARK launches with a shared transfer dir and cluster id (runtime-spec). */
export const CLUSTER_GAMES: readonly Game[] = [Game.ASA, Game.ASE];

/** Why a `game` server can't join a cluster whose other members run `memberGames`, or null. */
export function clusterJoinError(game: Game, memberGames: readonly string[]): string | null {
  if (!CLUSTER_GAMES.includes(game)) {
    return `${GAME_LABELS[game] ?? game} servers can't join a cluster. Clusters are for ARK servers.`;
  }
  // ASA and ASE are separate games with incompatible saves; nothing transfers between them.
  const other = memberGames.find((g) => g !== game) as Game | undefined;
  if (other) {
    return `This cluster holds ${GAME_LABELS[other] ?? other} servers, and ${GAME_LABELS[game]} can't transfer to them.`;
  }
  return null;
}
