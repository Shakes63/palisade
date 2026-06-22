import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { Rcon } from "rcon-client";
import { EventType, RealtimeTopic, Game } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { EventsService } from "../events/events.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { LogCaptureService } from "../logs/log-capture.service";
import { SourceRcon } from "./source-rcon";
import { containerName } from "../common/naming";
import { loadEnv } from "../config/env";

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeGateway,
    private readonly logCapture: LogCaptureService,
  ) {}

  private async connect(serverId: string): Promise<RconConn> {
    const existing = this.pool.get(serverId);
    if (existing) return existing;

    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new BadRequestException("Server not found");
    if (!server.adminPasswordEnc)
      throw new BadRequestException("Server has no admin password set");

    const password = this.crypto.decrypt(server.adminPasswordEnc);
    // On the bridge, game containers are reachable by name on ark-net. With host
    // networking they bind on the host, so reach RCON via the host gateway (the
    // manager must run with --add-host host.docker.internal:host-gateway).
    const host = loadEnv().GAME_HOST_NETWORK
      ? "host.docker.internal"
      : containerName(serverId, server.game as Game, server.name);
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
    const opts = { host, port: server.rconPort, password, timeout: 10_000 };
    const rcon: RconConn = server.game === Game.CONAN ? new SourceRcon(opts) : new Rcon(opts);
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
      throw new BadRequestException(`RCON failed: ${(err as Error).message}`);
    }
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

  async broadcast(serverId: string, message: string): Promise<string> {
    // ARK: ServerChat. Conan: broadcast.
    const game = await this.gameOf(serverId);
    return this.exec(serverId, game === Game.CONAN ? `broadcast ${message}` : `ServerChat ${message}`);
  }

  async saveWorld(serverId: string): Promise<string> {
    // ARK saves the world to .ark files (SaveWorld). Conan has no manual-save RCON
    // command — it persists continuously to a SQLite DB (and flushes on shutdown),
    // so there's nothing to issue (verified against the live server's `help`).
    const game = await this.gameOf(serverId);
    if (game === Game.CONAN) return "Conan saves continuously to its database — no manual save needed.";
    return this.exec(serverId, "SaveWorld");
  }

  doExit(serverId: string): Promise<string> {
    return this.exec(serverId, "DoExit");
  }

  async listPlayers(serverId: string): Promise<string[]> {
    const out = await this.exec(serverId, "ListPlayers");
    if (/no players/i.test(out)) return [];
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  kick(serverId: string, playerId: string): Promise<string> {
    return this.exec(serverId, `KickPlayer ${playerId}`);
  }

  ban(serverId: string, playerId: string): Promise<string> {
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
