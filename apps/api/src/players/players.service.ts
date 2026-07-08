import { Injectable, Logger } from "@nestjs/common";
import { Game, ServerState } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RconService } from "../rcon/rcon.service";
import { containerName } from "../common/naming";
import { loadEnv } from "../config/env";
import { a2sInfo, raknetPing, type QueryCount } from "./query-protocols";

/** How long a fetched count stays fresh — dashboards poll every 5 s, but hitting
 *  the game servers that often is pointless. */
const TTL_MS = 20_000;
/** How long a failed lookup is remembered (avoids hammering a booting server). */
const NEG_TTL_MS = 15_000;

/** Games whose query port answers standard Steam A2S_INFO. */
const A2S_GAMES = new Set<Game>([
  Game.ASE,
  Game.CONAN,
  Game.ICARUS,
  Game.VALHEIM,
  Game.SEVEN_DAYS,
  Game.ENSHROUDED,
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly rcon: RconService,
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

  private async fetch(serverId: string): Promise<QueryCount | null> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server || server.state !== ServerState.Running) return null;
    const game = server.game as Game;
    // Same reachability rule as RCON: host networking → via the host gateway;
    // bridge → the container name resolves on ark-net.
    const host = loadEnv().GAME_HOST_NETWORK
      ? "host.docker.internal"
      : containerName(serverId, game, server.name);
    try {
      if (A2S_GAMES.has(game)) {
        const count = await a2sInfo(host, server.queryPort);
        return { online: count.online, max: count.max ?? server.maxPlayers };
      }
      if (game === Game.BEDROCK) {
        const count = await raknetPing(host, server.gamePort);
        return { online: count.online, max: count.max ?? server.maxPlayers };
      }
      // ASA / Palworld / Minecraft: count via RCON (needs the admin password set).
      const players = await this.rcon.listPlayers(serverId);
      return { online: players.length, max: server.maxPlayers };
    } catch {
      return null; // unreachable/booting/no credentials — just unknown
    }
  }
}
