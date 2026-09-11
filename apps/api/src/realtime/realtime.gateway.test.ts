import { describe, it, expect, vi } from "vitest";
import { JwtService } from "@nestjs/jwt";
import { RealtimeTopic, type RealtimeMessage } from "@ark/shared";
import { AccessService } from "../auth/access.service";
import type { AuthUser } from "../auth/auth-user";

// The gateway decorator calls loadEnv() at import time; supply the required
// secrets before the module is evaluated.
vi.hoisted(() => {
  process.env.SECRETS_KEY ??= "a".repeat(64);
  process.env.JWT_SECRET ??= "test-jwt-secret-1234";
});
import { RealtimeGateway } from "./realtime.gateway";

// GH #73: a restricted user's socket must only ever sit in `server:<id>` rooms
// for servers they may see; unrestricted sockets sit in "all". The two sets are
// disjoint, so broadcasting to "all" plus `server:<id>` never double-delivers.

interface FakeSocket {
  id: string;
  data: { user?: AuthUser };
  rooms: Set<string>;
  disconnected: boolean;
  join(room: string): void;
  leave(room: string): void;
  disconnect(close?: boolean): void;
}

function makeSocket(id: string, user?: AuthUser): FakeSocket {
  const socket: FakeSocket = {
    id,
    data: { user },
    rooms: new Set([id]),
    disconnected: false,
    join: (room) => void socket.rooms.add(room),
    leave: (room) => void socket.rooms.delete(room),
    disconnect: () => {
      socket.disconnected = true;
      socket.rooms.clear();
    },
  };
  return socket;
}

function makeServer() {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const sockets = new Map<string, FakeSocket>();
  return {
    emitted,
    sockets: { sockets },
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => void emitted.push({ room, event, payload }),
    }),
    use: (_fn: unknown) => undefined,
  };
}

/** Users keyed by id: tokenVersion + restricted flag, plus direct server grants
 *  and cluster grants (the cluster→server mapping is `clusters`). */
function makeGateway(opts: {
  users: Record<string, { tokenVersion: number; restricted: boolean; role?: string }>;
  serverGrants?: Record<string, string[]>;
  clusterGrants?: Record<string, string[]>;
  clusters?: Record<string, string[]>;
}) {
  const serverGrants = opts.serverGrants ?? {};
  const clusterGrants = opts.clusterGrants ?? {};
  const clusters = opts.clusters ?? {};
  const prisma = {
    userServerAccess: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        (serverGrants[where.userId] ?? []).map((serverId) => ({ serverId })),
    },
    userClusterAccess: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        (clusterGrants[where.userId] ?? []).map((clusterId) => ({ clusterId })),
    },
    server: {
      findMany: async ({ where }: { where: { clusterId: { in: string[] } } }) =>
        where.clusterId.in.flatMap((c) => (clusters[c] ?? []).map((id) => ({ id }))),
    },
  };
  const access = new AccessService(prisma as never);
  const auth = {
    resolveToken: async (sub: unknown, ver: unknown) => {
      const user = typeof sub === "string" ? opts.users[sub] : undefined;
      if (!user || user.tokenVersion !== ver) return null;
      return { restricted: user.restricted };
    },
  };
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  const gateway = new RealtimeGateway(jwt, auth as never, access);
  const server = makeServer();
  gateway.server = server as never;
  return { gateway, server, access, auth, jwt, users: opts.users, serverGrants };
}

const user = (sub: string, restricted: boolean, role = "operator"): AuthUser =>
  ({ sub, username: sub, role, ver: 0, restricted }) as AuthUser;

const scopeRooms = (s: FakeSocket) => [...s.rooms].filter((r) => r === "all" || r.startsWith("server:")).sort();

describe("RealtimeGateway rooms", () => {
  it("unrestricted socket joins only 'all'", async () => {
    const { gateway } = makeGateway({ users: { u1: { tokenVersion: 0, restricted: false } } });
    const socket = makeSocket("s1", user("u1", false));
    await gateway.scope(socket as never);
    expect(scopeRooms(socket)).toEqual(["all"]);
  });

  it("admins are unrestricted even with the flag set", async () => {
    const { gateway } = makeGateway({ users: { a: { tokenVersion: 0, restricted: true, role: "admin" } } });
    const socket = makeSocket("s1", user("a", true, "admin"));
    await gateway.scope(socket as never);
    expect(scopeRooms(socket)).toEqual(["all"]);
  });

  it("restricted socket joins exactly its server rooms (direct + cluster members), never 'all'", async () => {
    const { gateway } = makeGateway({
      users: { u1: { tokenVersion: 0, restricted: true } },
      serverGrants: { u1: ["srv-a"] },
      clusterGrants: { u1: ["c1"] },
      clusters: { c1: ["srv-b", "srv-c"], c2: ["srv-z"] },
    });
    const socket = makeSocket("s1", user("u1", true));
    await gateway.scope(socket as never);
    expect(scopeRooms(socket)).toEqual(["server:srv-a", "server:srv-b", "server:srv-c"]);
  });

  it("restricted socket with no grants joins nothing", async () => {
    const { gateway } = makeGateway({ users: { u1: { tokenVersion: 0, restricted: true } } });
    const socket = makeSocket("s1", user("u1", true));
    await gateway.scope(socket as never);
    expect(scopeRooms(socket)).toEqual([]);
  });
});

describe("RealtimeGateway.broadcast", () => {
  it("server-scoped message goes to 'all' and 'server:<id>'", () => {
    const { gateway, server } = makeGateway({ users: {} });
    const message: RealtimeMessage = { topic: RealtimeTopic.ServerLog, serverId: "srv-a", payload: { line: "x" }, at: "now" };
    gateway.broadcast(message);
    expect(server.emitted).toEqual([
      { room: "all", event: "message", payload: message },
      { room: "server:srv-a", event: "message", payload: message },
    ]);
  });

  it("global message (no serverId) goes only to 'all'", () => {
    const { gateway, server } = makeGateway({ users: {} });
    const message: RealtimeMessage = { topic: RealtimeTopic.Event, payload: {}, at: "now" };
    gateway.broadcast(message);
    expect(server.emitted).toEqual([{ room: "all", event: "message", payload: message }]);
  });
});

describe("RealtimeGateway access changes", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("re-scopes a user's connected sockets when their grants change", async () => {
    const { gateway, server, access, serverGrants } = makeGateway({
      users: { u1: { tokenVersion: 0, restricted: true }, u2: { tokenVersion: 0, restricted: true } },
      serverGrants: { u1: ["srv-a"], u2: ["srv-a"] },
    });
    const s1 = makeSocket("s1", user("u1", true));
    const s2 = makeSocket("s2", user("u2", true));
    server.sockets.sockets.set(s1.id, s1).set(s2.id, s2);
    await gateway.scope(s1 as never);
    await gateway.scope(s2 as never);

    serverGrants.u1 = ["srv-b"];
    access.notifyChanged("u1");
    await flush();

    expect(scopeRooms(s1)).toEqual(["server:srv-b"]); // left srv-a, joined srv-b
    expect(scopeRooms(s2)).toEqual(["server:srv-a"]); // untouched
    expect(s1.disconnected).toBe(false);
  });

  it("flipping restricted off moves the socket from server rooms to 'all'", async () => {
    const { gateway, server, access, users } = makeGateway({
      users: { u1: { tokenVersion: 0, restricted: true } },
      serverGrants: { u1: ["srv-a"] },
    });
    const s1 = makeSocket("s1", user("u1", true));
    server.sockets.sockets.set(s1.id, s1);
    await gateway.scope(s1 as never);
    expect(scopeRooms(s1)).toEqual(["server:srv-a"]);

    users.u1!.restricted = false;
    access.notifyChanged("u1");
    await flush();

    expect(scopeRooms(s1)).toEqual(["all"]);
    expect(s1.data.user?.restricted).toBe(false);
  });

  it("disconnects a socket whose user no longer resolves (deleted / revoked)", async () => {
    const { gateway, server, access, users } = makeGateway({
      users: { u1: { tokenVersion: 0, restricted: false } },
    });
    const s1 = makeSocket("s1", user("u1", false));
    server.sockets.sockets.set(s1.id, s1);
    await gateway.scope(s1 as never);

    delete users.u1;
    access.notifyChanged("u1");
    await flush();

    expect(s1.disconnected).toBe(true);
  });

  it("stops listening after onModuleDestroy", async () => {
    const { gateway, server, access, serverGrants } = makeGateway({
      users: { u1: { tokenVersion: 0, restricted: true } },
      serverGrants: { u1: ["srv-a"] },
    });
    const s1 = makeSocket("s1", user("u1", true));
    server.sockets.sockets.set(s1.id, s1);
    await gateway.scope(s1 as never);

    gateway.onModuleDestroy();
    serverGrants.u1 = ["srv-b"];
    access.notifyChanged("u1");
    await flush();

    expect(scopeRooms(s1)).toEqual(["server:srv-a"]);
  });
});

describe("RealtimeGateway handshake", () => {
  type Middleware = (socket: { handshake: { auth?: { token?: string } }; data: Record<string, unknown> }, next: (err?: Error) => void) => Promise<void>;

  async function handshake(gateway: RealtimeGateway, token: string | undefined) {
    let middleware: Middleware | undefined;
    gateway.afterInit({ use: (fn: Middleware) => void (middleware = fn) } as never);
    const socket = { handshake: { auth: token ? { token } : {} }, data: {} as Record<string, unknown> };
    const err = await new Promise<Error | undefined>((resolve) => void middleware!(socket, resolve));
    return { err, socket };
  }

  it("stashes the resolved AuthUser on socket.data.user", async () => {
    const { gateway, jwt } = makeGateway({ users: { u1: { tokenVersion: 2, restricted: true } } });
    const token = await jwt.signAsync({ sub: "u1", username: "jo", role: "operator", ver: 2 });
    const { err, socket } = await handshake(gateway, token);
    expect(err).toBeUndefined();
    expect(socket.data.user).toMatchObject({ sub: "u1", username: "jo", role: "operator", ver: 2, restricted: true });
  });

  it("rejects missing, stale, and unknown-user tokens", async () => {
    const { gateway, jwt } = makeGateway({ users: { u1: { tokenVersion: 2, restricted: false } } });
    expect((await handshake(gateway, undefined)).err?.message).toBe("unauthorized");
    const stale = await jwt.signAsync({ sub: "u1", ver: 1 });
    expect((await handshake(gateway, stale)).err?.message).toBe("unauthorized");
    const ghost = await jwt.signAsync({ sub: "nobody", ver: 0 });
    expect((await handshake(gateway, ghost)).err?.message).toBe("unauthorized");
  });
});
