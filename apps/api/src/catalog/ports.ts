import { Game, type PortSet } from "@ark/shared";

/**
 * Each server gets a contiguous block of host ports derived from a single base,
 * so they are easy to port-forward as a range. Blocks are spaced by BLOCK_STRIDE.
 */
export const PORT_POOL_START = 7777;
export const BLOCK_STRIDE = 10;

/** Derive the 4 ports for a server from its allocated base port. */
export function derivePorts(basePort: number): PortSet {
  return {
    game: basePort,
    rawSocket: basePort + 1,
    query: basePort + 2,
    rcon: basePort + 3,
  };
}

/** Pick the next free base port given the set already in use. */
export function nextBasePort(usedBases: number[]): number {
  if (usedBases.length === 0) return PORT_POOL_START;
  const max = Math.max(...usedBases);
  return max + BLOCK_STRIDE;
}

/**
 * For now every server shares this one fixed port block, so a single set of
 * port-forwards covers whichever server is running — only one runs at a time
 * anyway. To go back to a unique block per server, restore the nextBasePort /
 * derivePorts allocation in ServersService.create().
 */
export const FIXED_PORTS: PortSet = derivePorts(PORT_POOL_START);

/**
 * Minecraft (Java) is TCP and has a single well-known port (25565) plus RCON
 * (25575). Using the standard ports means players just type the IP (no port) and
 * the port-forward is the canonical Minecraft one. rawSocket/query are unused.
 */
export const MINECRAFT_PORTS: PortSet = { game: 25565, rawSocket: 25566, query: 25565, rcon: 25575 };

/** The fixed port block a new server gets, by game. */
export function portsFor(game: Game): PortSet {
  return game === Game.MINECRAFT ? MINECRAFT_PORTS : FIXED_PORTS;
}
