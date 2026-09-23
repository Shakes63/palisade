import { Game, type PortSet } from "./game";

/** PZ's Steam comms ports (STEAMPORT1/STEAMPORT2) — fixed, UDP, player-facing. */
export const ZOMBOID_STEAM_PORTS = [8766, 8767] as const;

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
    case Game.PALWORLD_WINE:
      return [{ port: ports.game, proto: "udp", label: "game" }];
    case Game.ZOMBOID:
      return [
        { port: ports.game, proto: "udp", label: "game (+ query)" },
        { port: ports.rawSocket, proto: "udp", label: "direct connection" },
        { port: ZOMBOID_STEAM_PORTS[0], proto: "udp", label: "steam comms 1" },
        { port: ZOMBOID_STEAM_PORTS[1], proto: "udp", label: "steam comms 2" },
      ];
    case Game.VRISING:
      return [
        { port: ports.game, proto: "udp", label: "game" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
      ];
    case Game.SOTF:
      return [
        { port: ports.game, proto: "udp", label: "game" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
        { port: ports.rawSocket, proto: "udp", label: "blob sync" },
      ];
    case Game.SATISFACTORY:
      return [
        { port: ports.game, proto: "udp", label: "game" },
        { port: ports.game, proto: "tcp", label: "server API (join/manage)" },
        { port: ports.rawSocket, proto: "tcp", label: "reliable messaging" },
      ];
    case Game.LIF:
      return [
        { port: ports.game, proto: "tcp", label: "game (tcp)" },
        { port: ports.game, proto: "udp", label: "game (udp)" },
        { port: ports.rawSocket, proto: "tcp", label: "game +1 (tcp)" },
        { port: ports.rawSocket, proto: "udp", label: "game +1 (udp)" },
        { port: ports.query, proto: "tcp", label: "query (tcp)" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
      ];
    case Game.ATS:
    case Game.ETS2:
      return [
        { port: ports.game, proto: "udp", label: "connection" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
      ];
    case Game.CORE_KEEPER:
      return []; // Steam relay — nothing to forward
    case Game.TERRARIA:
      return [{ port: ports.game, proto: "tcp", label: "game" }]; // REST stays LAN-only
    case Game.FACTORIO:
      return [{ port: ports.game, proto: "udp", label: "game" }]; // RCON stays LAN-only
    case Game.RUST:
      return [
        { port: ports.game, proto: "udp", label: "game" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
        { port: ports.rawSocket, proto: "tcp", label: "Rust+ companion app" },
      ]; // RCON (28016 tcp) stays LAN-only
    case Game.BEAMMP:
      return [
        { port: ports.game, proto: "tcp", label: "game (tcp)" },
        { port: ports.game, proto: "udp", label: "game (udp)" },
      ];
    case Game.OPENTTD:
      return [
        { port: ports.game, proto: "tcp", label: "game (tcp)" },
        { port: ports.game, proto: "udp", label: "game (udp)" },
      ];
    case Game.CS2:
      return [
        { port: ports.game, proto: "tcp", label: "game (tcp)" },
        { port: ports.game, proto: "udp", label: "game + query (udp)" },
        { port: ports.rawSocket, proto: "udp", label: "CSTV spectator" },
      ];
    case Game.DST:
      return [
        { port: ports.game, proto: "udp", label: "master shard" },
        { port: ports.rawSocket, proto: "udp", label: "caves shard" },
        { port: ports.query, proto: "udp", label: "steam auth" },
        { port: ports.query + 1, proto: "udp", label: "steam master" },
      ];
    case Game.DRAGONWILDS:
      return [{ port: ports.game, proto: "udp", label: "game" }];
    default:
      // ARK family + Conan: game + raw socket + query, all UDP.
      return [
        { port: ports.game, proto: "udp", label: "game" },
        { port: ports.rawSocket, proto: "udp", label: "raw socket" },
        { port: ports.query, proto: "udp", label: "query (server browser)" },
      ];
  }
}

/** Games whose query port is a real, independently-configurable port. Valheim and
 *  7DTD derive theirs from the game port; the rest have none or answer on the game port. */
export const INDEPENDENT_QUERY_PORT: ReadonlySet<Game> = new Set([
  Game.ASA,
  Game.ASE,
  Game.CONAN,
  Game.ICARUS,
  Game.ENSHROUDED,
  Game.VRISING,
  Game.SOTF,
  Game.RUST,
]);

export interface ConsolePortSpec {
  label: string;
  /** False when the image fixes the port and offers no way to move it. */
  editable: boolean;
}

/** The TCP port the manager's console talks to, or null for games without one. */
export function consolePortSpec(game: Game): ConsolePortSpec | null {
  switch (game) {
    case Game.ASA:
    case Game.ASE:
    case Game.CONAN:
    case Game.PALWORLD:
    case Game.PALWORLD_WINE:
    case Game.MINECRAFT:
    case Game.VRISING:
    case Game.FACTORIO:
    case Game.RUST:
    case Game.CS2:
      return { label: "RCON port", editable: true };
    case Game.SEVEN_DAYS:
      return { label: "Telnet port", editable: true };
    case Game.ZOMBOID:
      // The danixu86 image has no RCON-port variable, so the game's ini default wins.
      return { label: "RCON port", editable: false };
    default:
      return null;
  }
}

/** Overview rows: each player-facing port once with all its protocols, then the
 *  console port. */
export function portRows(game: Game, ports: PortSet): { label: string; value: string }[] {
  const byPort = new Map<number, { label: string; protos: Set<string> }>();
  for (const f of forwardSpec(game, ports)) {
    const row = byPort.get(f.port) ?? { label: f.label, protos: new Set<string>() };
    row.protos.add(f.proto);
    byPort.set(f.port, row);
  }
  const rows = [...byPort].map(([port, { label, protos }]) => {
    const name = label.replace(/ \((tcp|udp)\)$/, "");
    const titled = name.charAt(0).toUpperCase() + name.slice(1);
    const paren = titled.indexOf(" (");
    return {
      label: paren < 0 ? `${titled} port` : `${titled.slice(0, paren)} port${titled.slice(paren)}`,
      value: `${port}/${[...protos].sort().join("+")}`,
    };
  });
  const consolePort = consolePortSpec(game);
  if (consolePort && ports.rcon > 0) rows.push({ label: consolePort.label, value: `${ports.rcon}/tcp` });
  return rows;
}
