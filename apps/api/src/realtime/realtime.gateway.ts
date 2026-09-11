import { Logger, OnModuleDestroy } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import type { RealtimeMessage } from "@ark/shared";
import { AccessService } from "../auth/access.service";
import type { AuthUser } from "../auth/auth-user";
import { AuthService } from "../auth/auth.service";
import { loadEnv } from "../config/env";

/**
 * Socket.IO gateway for live status, log tails, install progress, RCON output,
 * and events.
 *
 * Room model (GH #73, per-user server access): a socket is in EXACTLY ONE of
 * two shapes of room. Unrestricted users (admins, or accounts with no server
 * grants) sit in "all". Restricted users sit in one `server:<id>` room per
 * server they may see, and nothing else. `broadcast()` emits to "all" and, for
 * server-scoped messages, to `server:<id>` too — the two sets of sockets are
 * disjoint, so nobody receives a message twice, and global (serverId-less)
 * events reach only "all".
 */
// addTrailingSlash:false lets engine.io accept the path after Next's rewrite
// strips the trailing slash from `/socket.io/`; without it the polling
// handshake 404s behind the single-origin proxy.
// Same-origin through the Next rewrite proxy needs no CORS; cross-origin
// sockets are denied unless origins are allowed via CORS_ORIGINS (like the API).
@WebSocketGateway({
  cors: {
    origin: loadEnv().CORS_ORIGINS.length > 0 ? loadEnv().CORS_ORIGINS : false,
    credentials: true,
  },
  addTrailingSlash: false,
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly unsubscribeAccess: () => void;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly access: AccessService,
  ) {
    // An admin editing (or deleting) a user must take effect on that user's OPEN
    // sockets, not just at their next reconnect.
    this.unsubscribeAccess = this.access.onChanged((userId) => {
      void this.rescopeUser(userId).catch((err) => {
        this.logger.warn(`Failed to re-scope sockets for user ${userId}: ${String(err)}`);
      });
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeAccess();
  }

  /** Realtime traffic includes log tails and RCON output — require a valid,
   * unrevoked JWT in the socket.io handshake before any message flows. The
   * resolved user is kept on `socket.data.user` so the socket can be scoped. */
  afterInit(server: Server): void {
    server.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token as string | undefined;
        if (!token) return next(new Error("unauthorized"));
        const payload = await this.jwt.verifyAsync(token);
        const resolved = await this.auth.resolveToken(payload.sub, payload.ver);
        if (resolved === null) return next(new Error("unauthorized"));
        const user: AuthUser = { ...payload, restricted: resolved.restricted };
        socket.data.user = user;
        next();
      } catch {
        next(new Error("unauthorized"));
      }
    });
  }

  handleConnection(client: Socket): void {
    void this.scope(client).catch((err) => {
      this.logger.warn(`Failed to scope socket ${client.id}: ${String(err)}`);
      client.disconnect(true);
    });
  }

  handleDisconnect(_client: Socket): void {
    // no-op; sockets leave their rooms automatically
  }

  /**
   * Put the socket in the rooms its user may see: "all" for unrestricted users,
   * otherwise one `server:<id>` room per visible server. Safe to re-run — every
   * previous scope room is left first. The lookup happens BEFORE leaving, so a
   * re-scope never leaves the socket roomless while the DB is consulted.
   */
  async scope(socket: Socket): Promise<void> {
    const user = socket.data.user as AuthUser | undefined;
    const allowed = await this.access.allowedServerIds(user);
    for (const room of [...socket.rooms]) {
      if (room === "all" || room.startsWith("server:")) socket.leave(room);
    }
    if (allowed === "all") {
      socket.join("all");
      return;
    }
    for (const id of allowed) socket.join(`server:${id}`);
  }

  /**
   * Emit to "all" and, for server-scoped messages, to that server's room.
   * Unrestricted sockets are only in "all" and restricted sockets only in
   * server rooms, so each socket gets at most one copy. Messages without a
   * serverId (global events) reach only "all".
   */
  broadcast(message: RealtimeMessage): void {
    if (!this.server) return;
    this.server.to("all").emit("message", message);
    if (message.serverId) {
      this.server.to(`server:${message.serverId}`).emit("message", message);
    }
  }

  /** Re-read a user's grants onto each of their live sockets; drop sockets whose
   * token no longer resolves (user deleted or tokens revoked). */
  private async rescopeUser(userId: string): Promise<void> {
    const sockets = this.server?.sockets?.sockets;
    if (!sockets) return;
    for (const socket of sockets.values()) {
      const user = socket.data.user as AuthUser | undefined;
      if (user?.sub !== userId) continue;
      const resolved = await this.auth.resolveToken(user.sub, user.ver);
      if (resolved === null) {
        socket.disconnect(true);
        continue;
      }
      // `restricted` is DB-backed and may have just flipped; refresh it or an
      // account newly restricted would still scope as unrestricted.
      socket.data.user = { ...user, restricted: resolved.restricted } satisfies AuthUser;
      await this.scope(socket);
    }
  }
}
