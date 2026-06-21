import type { PortSet } from "@ark/shared";

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
