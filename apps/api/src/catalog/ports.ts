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

/**
 * Icarus uses two UDP ports — game (17777) + Steam query (27015) — and has NO
 * network RCON, so rcon is 0 (unused; the Console UI is hidden for Icarus).
 */
export const ICARUS_PORTS: PortSet = { game: 17777, rawSocket: 17778, query: 27015, rcon: 0 };

/**
 * Bedrock listens on UDP 19132 (IPv4) + 19133 (IPv6) and has NO RCON. The rawSocket
 * slot carries the IPv6 port; query is unused and rcon is 0 (Console UI hidden).
 */
export const BEDROCK_PORTS: PortSet = { game: 19132, rawSocket: 19133, query: 19132, rcon: 0 };

/** The fixed port block a new server gets, by game. */
export function portsFor(game: Game): PortSet {
  if (game === Game.MINECRAFT) return MINECRAFT_PORTS;
  if (game === Game.ICARUS) return ICARUS_PORTS;
  if (game === Game.BEDROCK) return BEDROCK_PORTS;
  return FIXED_PORTS;
}
