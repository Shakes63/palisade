import { Injectable, Logger } from "@nestjs/common";
import { Game, ServerState } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RconService } from "../rcon/rcon.service";
import { CryptoService } from "../crypto/crypto.service";
import { satisfactoryQueryState } from "./satisfactory-api";
import { containerName } from "../common/naming";
import { GameEndpointService } from "../docker/game-endpoint.service";
import { a2sInfo, raknetPing, type QueryCount } from "./query-protocols";
import { ProbeHealthTracker } from "./probe-health";

/** How long a fetched count stays fresh — dashboards poll every 5 s, but hitting
 *  the game servers that often is pointless. */
const TTL_MS = 20_000;
/** How long a failed lookup is remembered (avoids hammering a booting server). */
const NEG_TTL_MS = 15_000;

/** Games whose query port answers standard Steam A2S_INFO. NOT Valheim — its
 *  queries go through Steam's relay, so it never answers direct A2S (verified
 *  live); it gets the lloesche image's HTTP status endpoint instead. */
const A2S_GAMES = new Set<Game>([
  Game.ASE,
  Game.CONAN,
  Game.ICARUS,
  Game.SEVEN_DAYS,
  Game.ENSHROUDED,
  Game.VRISING,
  Game.SOTF,
  Game.LIF,
  Game.ATS,
  Game.ETS2,
  Game.RUST,
  Game.CS2, // standard A2S on the game/query UDP port
]);

/**
 * Live player counts for running servers. Strategy per game:
 * - Steam A2S_INFO on the query port (no credentials needed) for the six games above.
 * - RakNet unconnected ping on the game port for Bedrock.
 * - RCON for the games with no usable query protocol: ASA (EOS — no A2S), Palworld,
 *   Minecraft Java (its Server List Ping isn't worth a third protocol — RCON's `list`
 *   is already wired).
 * Results are cached (TTL above); failures are cached briefly too and surface as
 * null (the UI shows nothing rather than a scary error).
 */
@Injectable()
export class PlayersService {
  private readonly logger = new Logger(PlayersService.name);
  private readonly cache = new Map<string, { count: QueryCount | null; at: number; ok: boolean }>();
  private readonly inflight = new Map<string, Promise<QueryCount | null>>();
  /** "Was answering, stopped answering" per run — feeds the Unhealthy badge. */
  private readonly probeHealth = new ProbeHealthTracker();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rcon: RconService,
    private readonly crypto: CryptoService,
    private readonly endpoints: GameEndpointService,
  ) {}

  /**
   * The server's current player count, or null when unknown (not running, query
   * unanswered, RCON not configured…). Cached; safe to call on every stats poll.
   */
  async count(serverId: string): Promise<QueryCount | null> {
    const hit = this.cache.get(serverId);
    if (hit && Date.now() - hit.at < (hit.ok ? TTL_MS : NEG_TTL_MS)) return hit.count;
    const running = this.inflight.get(serverId);
    if (running) return running;
    const p = this.fetch(serverId)
      .then((count) => {
        this.cache.set(serverId, { count, at: Date.now(), ok: count !== null });
        return count;
      })
      .finally(() => this.inflight.delete(serverId));
    this.inflight.set(serverId, p);
    return p;
  }

  /** The cached value only — never triggers a query (for hot paths like list()). */
  cached(serverId: string): QueryCount | null {
    return this.cache.get(serverId)?.count ?? null;
  }

  /** Non-null when a Running server's probe was answering and has now been
   *  silent past the threshold (~3 min) — the game process is likely hung. */
  probeFailingSince(serverId: string): { failingForMs: number } | null {
    return this.probeHealth.failingSince(serverId);
  }

  private async fetch(serverId: string): Promise<QueryCount | null> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server || server.state !== ServerState.Running) {
      // Not Running → any prior probe history is for a finished run.
      this.probeHealth.reset(serverId);
      return null;
    }
    const count = await this.fetchFor(serverId, server).catch(() => null);
    this.probeHealth.record(serverId, count !== null);
    return count;
  }

  private async fetchFor(
    serverId: string,
    server: NonNullable<Awaited<ReturnType<PrismaService["server"]["findUnique"]>>>,
  ): Promise<QueryCount | null> {
    const game = server.game as Game;
    // Same reachability rule as RCON, and derived the same way — from the container's
    // real networking rather than a global flag (GH #21). Resolved per probe because
    // each protocol below targets a different port.
    const fallbackHost = containerName(serverId, game, server.name);
    const at = (port: number, protocol: "tcp" | "udp") =>
      this.endpoints.resolve(serverId, port, fallbackHost, protocol);
    try {
      if (A2S_GAMES.has(game)) {
        const { host, port } = await at(server.queryPort, "udp");
        const count = await a2sInfo(host, port);
        return { online: count.online, max: count.max ?? server.maxPlayers };
      }
      if (game === Game.VALHEIM) {
        // The lloesche image's built-in HTTP status endpoint (STATUS_HTTP), on
        // game port + 3 by our convention (set in buildValheimSpec).
        const { host, port } = await at(server.gamePort + 3, "tcp");
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 2500);
        try {
          const res = await fetch(`http://${host}:${port}/status.json`, {
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const j = (await res.json()) as { player_count?: number; players?: unknown[] };
          const online = j.player_count ?? (Array.isArray(j.players) ? j.players.length : null);
          return online === null ? null : { online, max: server.maxPlayers };
        } finally {
          clearTimeout(t);
        }
      }
      if (game === Game.BEDROCK) {
        const { host, port } = await at(server.gamePort, "udp");
        const count = await raknetPing(host, port);
        return { online: count.online, max: count.max ?? server.maxPlayers };
      }
      if (game === Game.TERRARIA) {
        // TShock's REST API (enabled iff an admin token is set). /v2/server/status
        // returns playercount + maxplayers as JSON.
        if (!server.adminPasswordEnc) return null;
        const token = this.crypto.decrypt(server.adminPasswordEnc);
        const { host, port } = await at(server.rconPort, "tcp");
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 2500);
        try {
          const res = await fetch(
            `http://${host}:${port}/v2/server/status?token=${encodeURIComponent(token)}`,
            { signal: controller.signal },
          );
          if (!res.ok) return null;
          const j = (await res.json()) as { playercount?: number; maxplayers?: number };
          if (j.playercount === undefined) return null;
          return { online: j.playercount, max: j.maxplayers ?? server.maxPlayers };
        } finally {
          clearTimeout(t);
        }
      }
      if (game === Game.SATISFACTORY) {
        // The game's HTTPS API on the game port (no A2S). Passwordless Client
        // login unless a join password forces the admin-password fallback.
        const { host, port } = await at(server.gamePort, "tcp");
        const state = await satisfactoryQueryState(
          host,
          port,
          server.adminPasswordEnc ? this.crypto.decrypt(server.adminPasswordEnc) : null,
        );
        return state ? { online: state.online, max: state.max || server.maxPlayers } : null;
      }
      // ASA / Palworld / Minecraft / Zomboid: count via RCON (needs the admin password set).
      const players = await this.rcon.listPlayers(serverId);
      return { online: players.length, max: server.maxPlayers };
    } catch {
      return null; // unreachable/booting/no credentials — just unknown
    }
  }
}
