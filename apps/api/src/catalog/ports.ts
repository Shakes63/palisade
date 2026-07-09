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

/**
 * Valheim listens on UDP 2456 (game) + 2457 (Steam query, game+1); 2458 (game+2) is
 * the crossplay backend port. No RCON. rawSocket carries 2458, rcon is 0.
 */
export const VALHEIM_PORTS: PortSet = { game: 2456, rawSocket: 2458, query: 2457, rcon: 0 };

/**
 * 7 Days to Die: game port 26900 (TCP + UDP), plus 26901 + 26902 UDP; the telnet
 * console (the game's "RCON") is on 8081/TCP — carried in the rcon slot.
 */
export const SEVEN_DAYS_PORTS: PortSet = { game: 26900, rawSocket: 26901, query: 26902, rcon: 8081 };

/**
 * Enshrouded uses two UDP ports — game (15636) + Steam query (15637) — and has NO
 * RCON. rawSocket carries the query port and rcon is 0 (Console UI hidden).
 */
export const ENSHROUDED_PORTS: PortSet = { game: 15636, rawSocket: 15637, query: 15637, rcon: 0 };

/**
 * Project Zomboid: game on UDP 16261, direct-connection on UDP 16262; the Steam
 * query answers on the game port itself. Source RCON on TCP 27015 — the PZ ini
 * default (the danixu86 image has no RCON-port env var) — carried in the rcon
 * slot. rawSocket carries the direct port. Steam also needs its two fixed
 * comms ports (8766/8767 UDP, ZOMBOID_STEAM_PORTS below).
 */
export const ZOMBOID_PORTS: PortSet = { game: 16261, rawSocket: 16262, query: 16261, rcon: 27015 };

/** PZ's Steam comms ports (STEAMPORT1/STEAMPORT2) — fixed, UDP, player-facing. */
export const ZOMBOID_STEAM_PORTS = [8766, 8767] as const;

/**
 * Every host port a server binds (skipping unused 0 slots — e.g. rcon on no-RCON
 * games). Valheim also binds its HTTP status endpoint on game + 3, and Minecraft's
 * query column mirrors the game port (the set dedupes it). Used by the start-time
 * port-conflict guard.
 */
export function serverPortSet(game: Game, ports: PortSet): Set<number> {
  const set = new Set<number>();
  for (const p of [ports.game, ports.rawSocket, ports.query, ports.rcon]) if (p > 0) set.add(p);
  if (game === Game.VALHEIM) set.add(ports.game + 3); // STATUS_HTTP (player counts)
  if (game === Game.ZOMBOID) for (const p of ZOMBOID_STEAM_PORTS) set.add(p); // Steam comms
  return set;
}

export interface ForwardPort {
  port: number;
  proto: "udp" | "tcp";
  label: string;
}

/**
 * The PLAYER-FACING ports a game needs forwarded on the router (what we've been
 * creating on pfSense by hand per game). Deliberately excludes admin/internal
 * ports: RCON, 7DTD telnet, and Valheim's HTTP status endpoint stay LAN-only.
 */
export function forwardSpec(game: Game, ports: PortSet): ForwardPort[] {
  switch (game) {
    case Game.MINECRAFT:
      return [{ port: ports.game, proto: "tcp", label: "game" }];
    case Game.BEDROCK:
      return [
        { port: ports.game, proto: "udp", label: "game (IPv4)" },
        { port: ports.rawSocket, proto: "udp", label: "game (IPv6)" },
      ];
    case Game.ICARUS:
    case Game.ENSHROUDED:
      return [
        { port: ports.game, proto: "udp", label: "game" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
      ];
    case Game.VALHEIM:
      return [
        { port: ports.game, proto: "udp", label: "game" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
        { port: ports.rawSocket, proto: "udp", label: "crossplay" },
      ];
    case Game.SEVEN_DAYS:
      return [
        { port: ports.game, proto: "tcp", label: "game (tcp)" },
        { port: ports.game, proto: "udp", label: "game (udp)" },
        { port: ports.rawSocket, proto: "udp", label: "game +1" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
      ];
    case Game.PALWORLD:
      return [{ port: ports.game, proto: "udp", label: "game" }];
    case Game.ZOMBOID:
      return [
        { port: ports.game, proto: "udp", label: "game (+ query)" },
        { port: ports.rawSocket, proto: "udp", label: "direct connection" },
        { port: ZOMBOID_STEAM_PORTS[0], proto: "udp", label: "steam comms 1" },
        { port: ZOMBOID_STEAM_PORTS[1], proto: "udp", label: "steam comms 2" },
      ];
    default:
      // ARK family + Conan: game + raw socket + query, all UDP.
      return [
        { port: ports.game, proto: "udp", label: "game" },
        { port: ports.rawSocket, proto: "udp", label: "raw socket" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
      ];
  }
}

/** The fixed port block a new server gets, by game. */
export function portsFor(game: Game): PortSet {
  if (game === Game.MINECRAFT) return MINECRAFT_PORTS;
  if (game === Game.ICARUS) return ICARUS_PORTS;
  if (game === Game.BEDROCK) return BEDROCK_PORTS;
  if (game === Game.VALHEIM) return VALHEIM_PORTS;
  if (game === Game.SEVEN_DAYS) return SEVEN_DAYS_PORTS;
  if (game === Game.ENSHROUDED) return ENSHROUDED_PORTS;
  if (game === Game.ZOMBOID) return ZOMBOID_PORTS;
  return FIXED_PORTS;
}
