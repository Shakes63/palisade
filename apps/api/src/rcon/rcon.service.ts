import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { Rcon } from "rcon-client";
import { EventType, RealtimeTopic, Game } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { EventsService } from "../events/events.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { LogCaptureService } from "../logs/log-capture.service";
import { SourceRcon } from "./source-rcon";
import { TelnetRcon } from "./telnet-rcon";
import { rconArg } from "./rcon-arg";
import { containerName } from "../common/naming";
import { GameEndpointService } from "../docker/game-endpoint.service";
import type { ResolvedEndpoint } from "../common/game-endpoint";

/** The slice of a connection RconService uses — satisfied by both rcon-client's
 *  Rcon (ARK/ASE) and our lenient SourceRcon (Conan). */
interface RconConn {
  connect(): Promise<unknown>;
  send(command: string): Promise<string>;
  end(): Promise<unknown>;
  on(event: "error" | "end", listener: (...args: unknown[]) => void): unknown;
}

/**
 * RCON access to running servers. Connections are pooled per server and reused;
 * a failed send drops the connection so the next call reconnects.
 */
@Injectable()
export class RconService {
  private readonly logger = new Logger(RconService.name);
  private readonly pool = new Map<string, RconConn>();
  /** The endpoint each connection was opened to, so a failure can explain itself in
   *  terms of the address we actually dialled. Bounded by the server count. */
  private readonly dialled = new Map<string, ResolvedEndpoint>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeGateway,
    private readonly logCapture: LogCaptureService,
    private readonly endpoints: GameEndpointService,
  ) {}

  private async connect(serverId: string): Promise<RconConn> {
    const existing = this.pool.get(serverId);
    if (existing) return existing;

    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new BadRequestException("Server not found");
    if (!server.adminPasswordEnc)
      throw new BadRequestException("Server has no admin password set");

    const password = this.crypto.decrypt(server.adminPasswordEnc);
    // Derived from the container's real networking — its IP on a network we share,
    // the host gateway when it's on the host or its port is published, and only then
    // the container name. Guessing this from GAME_HOST_NETWORK alone broke every
    // deployment where the flag and reality disagreed (GH #21).
    const endpoint = await this.endpoints.resolve(
      serverId,
      server.rconPort,
      containerName(serverId, server.game as Game, server.name),
    );
    this.dialled.set(serverId, endpoint);
    // 2s (the lib default) is too tight over the container network; 10s keeps
    // interactive commands snappy without spurious timeouts. (The world save on
    // stop is handled by the container's graceful SIGTERM shutdown, not by waiting
    // on the SaveWorld RCON reply — ARK doesn't reliably reply when it's done.)
    // Construct + attach the 'error' listener BEFORE connecting, not after. The
    // static Rcon.connect() wires up `socket.on("error", e => emitter.emit("error"))`
    // internally and only resolves after auth — so attaching our listener after it
    // returns leaves a window (the connect/auth phase, and any reconnect that races
    // the container being killed during a stop) where a socket ECONNRESET re-emits
    // on an emitter with NO 'error' listener. Node then throws an unhandled 'error'
    // event and the ENTIRE manager process crashes. Attaching first closes that
    // window for the connection's whole lifetime.
    // Conan Exiles replies to RCON commands with a non-matching packet id, which
    // makes rcon-client's strict id matching time out on every command (auth still
    // succeeds). Route Conan through our lenient SourceRcon; ARK/ASE keep
    // rcon-client, which they work with. (See source-rcon.ts.)
    const opts = { host: endpoint.host, port: endpoint.port, password, timeout: 10_000 };
    // Conan AND Palworld reply with non-matching packet ids that time out
    // rcon-client's strict matching — route both through the lenient SourceRcon.
    // 7 Days to Die has no Source RCON at all — its console is telnet on 8081, so it
    // goes through the line-based TelnetRcon adapter instead.
    const game = server.game as Game;
    // Zomboid's RCON is Source-protocol but its replies also mismatch ids on some
    // builds — the lenient adapter handles it (and everything strict would).
    const lenient = game === Game.CONAN || game === Game.PALWORLD || game === Game.PALWORLD_WINE || game === Game.ZOMBOID;
    const rcon: RconConn =
      game === Game.SEVEN_DAYS ? new TelnetRcon(opts) : lenient ? new SourceRcon(opts) : new Rcon(opts);
    rcon.on("error", () => this.pool.delete(serverId));
    rcon.on("end", () => this.pool.delete(serverId));
    await rcon.connect();
    this.pool.set(serverId, rcon);
    return rcon;
  }

  /** Run a raw RCON command and return the server's response. */
  async exec(serverId: string, command: string): Promise<string> {
    try {
      const rcon = await this.connect(serverId);
      const response = await rcon.send(command);
      this.logCapture.recordConsole(serverId, `> ${command}`);
      this.logCapture.recordConsole(serverId, response);
      this.realtime.broadcast({
        topic: RealtimeTopic.RconOutput,
        serverId,
        payload: { command, response },
        at: new Date().toISOString(),
      });
      await this.events.emit({
        type: EventType.RconCommand,
        message: `RCON: ${command}`,
        serverId,
        data: { command },
      });
      return response;
    } catch (err) {
      this.pool.delete(serverId);
      throw new BadRequestException(`RCON failed: ${await this.describeFailure(serverId, err as Error)}`);
    }
  }

  /**
   * The raw error, plus a plain-English cause when the failure is one we can pin on
   * how the manager reaches the container. A bare `getaddrinfo ENOTFOUND palworld-…`
   * told users nothing about what to change (GH #21).
   */
  private async describeFailure(serverId: string, err: Error): Promise<string> {
    const endpoint = this.dialled.get(serverId);
    if (!endpoint) return err.message;
    const hint = await this.endpoints.explain(serverId, err, endpoint).catch(() => null);
    return hint ? `${err.message} — ${hint}` : err.message;
  }

  // ── Convenience wrappers ───────────────────────────────────────────────────
  /** The server's game, for picking the right console command syntax. */
  private async gameOf(serverId: string): Promise<Game> {
    const s = await this.prisma.server.findUnique({
      where: { id: serverId },
      select: { game: true },
    });
    if (!s) throw new BadRequestException("Server not found");
    return s.game as Game;
  }

  async broadcast(serverId: string, rawMessage: string): Promise<string> {
    // ARK: ServerChat. Conan: broadcast. Palworld: Broadcast. Minecraft: say. 7DTD: say.
    const game = await this.gameOf(serverId);
    const message = rconArg(rawMessage);
    if (game === Game.CONAN) return this.exec(serverId, `broadcast ${message}`);
    if (game === Game.PALWORLD || game === Game.PALWORLD_WINE) return this.exec(serverId, `Broadcast ${message}`);
    if (game === Game.MINECRAFT) return this.exec(serverId, `say ${message}`);
    if (game === Game.SEVEN_DAYS) return this.exec(serverId, `say "${message}"`);
    if (game === Game.ZOMBOID) return this.exec(serverId, `servermsg "${message}"`);
    if (game === Game.VRISING) return this.exec(serverId, `announce ${message}`);
    if (game === Game.FACTORIO) return this.exec(serverId, message); // bare text = chat
    if (game === Game.RUST) return this.exec(serverId, `say ${message}`);
    if (game === Game.CS2) return this.exec(serverId, `say ${message}`);
    return this.exec(serverId, `ServerChat ${message}`);
  }

  async saveWorld(serverId: string): Promise<string> {
    // ARK: SaveWorld. Palworld: Save. Minecraft: save-all. 7DTD: saveworld. Conan has
    // no manual-save command — it persists continuously to SQLite (flushes on shutdown).
    const game = await this.gameOf(serverId);
    if (game === Game.CONAN) return "Conan saves continuously to its database — no manual save needed.";
    if (game === Game.PALWORLD || game === Game.PALWORLD_WINE) return this.exec(serverId, "Save");
    if (game === Game.MINECRAFT) return this.exec(serverId, "save-all");
    if (game === Game.SEVEN_DAYS) return this.exec(serverId, "saveworld");
    if (game === Game.ZOMBOID) return this.exec(serverId, "save");
    if (game === Game.FACTORIO) return this.exec(serverId, "/server-save");
    if (game === Game.RUST) return this.exec(serverId, "server.save");
    if (game === Game.CS2) return "CS2 rounds are stateless — nothing to save.";
    if (game === Game.VRISING)
      return "V Rising autosaves on an interval and flushes on shutdown — no manual save command.";
    return this.exec(serverId, "SaveWorld");
  }

  doExit(serverId: string): Promise<string> {
    return this.exec(serverId, "DoExit");
  }

  async listPlayers(serverId: string): Promise<string[]> {
    const game = await this.gameOf(serverId);
    // Minecraft: `list` → "There are 2 of a max of 20 players online: Steve, Alex".
    if (game === Game.MINECRAFT) {
      const out = await this.exec(serverId, "list");
      const names = out.split(/online:/i)[1] ?? "";
      return names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
    }
    // 7DTD `lp` → "1. id=EOS_..., PlayerName, pos=(...), ..." + a "Total of N" line.
    if (game === Game.SEVEN_DAYS) {
      const out = await this.exec(serverId, "listplayers");
      return out
        .split("\n")
        .map((l) => l.match(/^\s*\d+\.\s*id=\S+?,\s*([^,]+?),/i)?.[1]?.trim())
        .filter((n): n is string => Boolean(n));
    }
    // Palworld `ShowPlayers` → CSV with a "name,playeruid,steamid" header row.
    if (game === Game.PALWORLD || game === Game.PALWORLD_WINE) {
      const out = await this.exec(serverId, "ShowPlayers");
      return out
        .split("\n")
        .slice(1) // drop the header
        .map((l) => l.split(",")[0]?.trim())
        .filter((n): n is string => Boolean(n));
    }
    // Rust `status` → header lines then '76561198… "Name" …' player rows.
    if (game === Game.RUST) {
      const out = await this.exec(serverId, "status");
      return [...out.matchAll(/^\s*\d{17}\s+"([^"]+)"/gm)].map((m) => m[1]!).filter(Boolean);
    }
    // Factorio `/players online` → "Online players (N):" then "  name (online)" lines.
    if (game === Game.FACTORIO) {
      const out = await this.exec(serverId, "/players online");
      return out
        .split("\n")
        .slice(1)
        .map((l) => l.replace(/\(online\)/i, "").trim())
        .filter(Boolean);
    }
    // Zomboid `players` → "Players connected (N):" then one "-name" line each.
    if (game === Game.ZOMBOID) {
      const out = await this.exec(serverId, "players");
      return out
        .split("\n")
        .map((l) => l.match(/^\s*-\s*(.+?)\s*$/)?.[1])
        .filter((n): n is string => Boolean(n));
    }
    const out = await this.exec(serverId, "ListPlayers");
    if (/no players/i.test(out)) return [];
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async kick(serverId: string, rawPlayerId: string): Promise<string> {
    // 7DTD: `kick <name/id>`. Minecraft: `kick`. ARK-family: `KickPlayer`.
    const game = await this.gameOf(serverId);
    const playerId = rconArg(rawPlayerId);
    if (game === Game.SEVEN_DAYS) return this.exec(serverId, `kick "${playerId}"`);
    if (game === Game.ZOMBOID) return this.exec(serverId, `kickuser "${playerId}"`);
    if (game === Game.FACTORIO) return this.exec(serverId, `/kick ${playerId}`);
    if (game === Game.RUST) return this.exec(serverId, `kickid ${playerId}`);
    if (game === Game.CS2) return this.exec(serverId, `kickid ${playerId}`);
    if (game === Game.MINECRAFT) return this.exec(serverId, `kick ${playerId}`);
    return this.exec(serverId, `KickPlayer ${playerId}`);
  }

  async ban(serverId: string, rawPlayerId: string): Promise<string> {
    // 7DTD: `ban add <name/id> 365 days`. Minecraft: `ban`. ARK-family: `BanPlayer`.
    const game = await this.gameOf(serverId);
    const playerId = rconArg(rawPlayerId);
    if (game === Game.SEVEN_DAYS) return this.exec(serverId, `ban add "${playerId}" 365 days "banned"`);
    if (game === Game.ZOMBOID) return this.exec(serverId, `banuser "${playerId}"`);
    if (game === Game.FACTORIO) return this.exec(serverId, `/ban ${playerId}`);
    if (game === Game.RUST) return this.exec(serverId, `banid ${playerId}`);
    if (game === Game.CS2) return this.exec(serverId, `banid 0 ${playerId}`); // 0 = permanent
    if (game === Game.MINECRAFT) return this.exec(serverId, `ban ${playerId}`);
    return this.exec(serverId, `BanPlayer ${playerId}`);
  }

  /** Close a pooled connection (called when a server stops). */
  async disconnect(serverId: string): Promise<void> {
    const rcon = this.pool.get(serverId);
    this.pool.delete(serverId);
    if (!rcon) return;
    // end() awaits the socket's "end" event, which may never arrive if the peer
    // was just killed — bound it so it can't stall a shutdown. The error/end
    // listeners stay attached, so any late ECONNRESET is still swallowed.
    await Promise.race([
      rcon.end().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
}
