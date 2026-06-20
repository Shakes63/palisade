import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { Rcon } from "rcon-client";
import { EventType, RealtimeTopic } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { EventsService } from "../events/events.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { containerName } from "../common/naming";
import { loadEnv } from "../config/env";

/**
 * RCON access to running servers. Connections are pooled per server and reused;
 * a failed send drops the connection so the next call reconnects.
 */
@Injectable()
export class RconService {
  private readonly logger = new Logger(RconService.name);
  private readonly pool = new Map<string, Rcon>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private async connect(serverId: string): Promise<Rcon> {
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
      : containerName(serverId, server.name);
    // 2s (the lib default) is too tight over the container network; 10s keeps
    // interactive commands snappy without spurious timeouts. Big world saves use
    // a dedicated longer-timeout connection (see saveAndWait).
    const rcon = await Rcon.connect({ host, port: server.rconPort, password, timeout: 10_000 });
    rcon.on("error", () => this.pool.delete(serverId));
    rcon.on("end", () => this.pool.delete(serverId));
    this.pool.set(serverId, rcon);
    return rcon;
  }

  /** Run a raw RCON command and return the server's response. */
  async exec(serverId: string, command: string): Promise<string> {
    try {
      const rcon = await this.connect(serverId);
      const response = await rcon.send(command);
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
  broadcast(serverId: string, message: string): Promise<string> {
    return this.exec(serverId, `ServerChat ${message}`);
  }

  saveWorld(serverId: string): Promise<string> {
    return this.exec(serverId, "SaveWorld");
  }

  /**
   * Save the world and wait for the save to actually finish before returning.
   * ARK's SaveWorld RCON only replies once the save is written to disk, so we use
   * a dedicated connection with a long timeout — the pooled connection's short
   * timeout would cut a large save off and the caller would proceed mid-save.
   */
  async saveAndWait(serverId: string, timeoutMs = 120_000): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server?.adminPasswordEnc)
      throw new BadRequestException("Server has no admin password set");
    const password = this.crypto.decrypt(server.adminPasswordEnc);
    const host = loadEnv().GAME_HOST_NETWORK
      ? "host.docker.internal"
      : containerName(serverId, server.name);
    const rcon = await Rcon.connect({ host, port: server.rconPort, password, timeout: timeoutMs });
    try {
      const response = await rcon.send("SaveWorld"); // resolves once the save completes
      this.realtime.broadcast({
        topic: RealtimeTopic.RconOutput,
        serverId,
        payload: { command: "SaveWorld", response },
        at: new Date().toISOString(),
      });
      await this.events.emit({
        type: EventType.RconCommand,
        message: "Saved world before stopping",
        serverId,
        data: { command: "SaveWorld" },
      });
    } finally {
      await rcon.end().catch(() => undefined);
    }
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
    await rcon?.end().catch(() => undefined);
  }
}
