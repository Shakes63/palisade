import { describe, it, expect } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ServerAccessGuard } from "./server-access.guard";
import type { AuthUser } from "./auth-user";

// Per-user scoping from the route template alone (GH #73): `servers/:id`
// routes check the server, `clusters/:id` routes check the cluster, and
// restricted users may never create servers. Everything else is left to the
// handlers, which check with AccessService themselves.
interface Options {
  method: string;
  /** Express route template as the app sees it, e.g. "/api/servers/:id/start". */
  path: string;
  params?: Record<string, string>;
  user?: Partial<AuthUser> | null;
  isPublic?: boolean;
  /** Server/cluster ids the fake AccessService should deny. */
  deny?: string[];
}

function makeContext(opts: Options) {
  const reflector = {
    getAllAndOverride: (key: string) => (key === "isPublic" ? (opts.isPublic ?? false) : undefined),
  };
  const calls: string[] = [];
  const deny = new Set(opts.deny ?? []);
  const access = {
    assertServer: async (_user: AuthUser | undefined, id: string) => {
      calls.push(`server:${id}`);
      if (deny.has(id)) throw new NotFoundException(`Server ${id} not found`);
    },
    assertCluster: async (_user: AuthUser | undefined, id: string) => {
      calls.push(`cluster:${id}`);
      if (deny.has(id)) throw new NotFoundException(`Cluster ${id} not found`);
    },
  };
  const user: AuthUser | undefined =
    opts.user === null
      ? undefined
      : { sub: "u1", ver: 0, role: "operator", restricted: true, ...opts.user };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({
        method: opts.method,
        user,
        params: opts.params ?? {},
        route: { path: opts.path },
      }),
    }),
  };
  const guard = new ServerAccessGuard(reflector as never, access as never);
  return { run: () => guard.canActivate(context as never), calls };
}

describe("ServerAccessGuard bypasses", () => {
  it("@Public routes skip the check entirely", async () => {
    const { run, calls } = makeContext({
      method: "POST",
      path: "/api/servers/:id/start",
      params: { id: "s1" },
      isPublic: true,
      deny: ["s1"],
    });
    expect(await run()).toBe(true);
    expect(calls).toEqual([]);
  });

  it("admins never trigger a check, even with restricted=true", async () => {
    const { run, calls } = makeContext({
      method: "POST",
      path: "/api/servers/:id/start",
      params: { id: "s1" },
      user: { role: "admin", restricted: true },
      deny: ["s1"],
    });
    expect(await run()).toBe(true);
    expect(calls).toEqual([]);
  });

  it("legacy tokens without a role count as admin", async () => {
    const { run, calls } = makeContext({
      method: "POST",
      path: "/api/servers",
      user: { role: undefined, restricted: true },
    });
    expect(await run()).toBe(true);
    expect(calls).toEqual([]);
  });

  it("an unrestricted operator never triggers a check", async () => {
    const { run, calls } = makeContext({
      method: "DELETE",
      path: "/api/servers/:id",
      params: { id: "s1" },
      user: { role: "operator", restricted: false },
      deny: ["s1"],
    });
    expect(await run()).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("ServerAccessGuard for a restricted user", () => {
  it("checks the server on /api/servers/:id/action", async () => {
    const { run, calls } = makeContext({ method: "POST", path: "/api/servers/:id/start", params: { id: "s1" } });
    expect(await run()).toBe(true);
    expect(calls).toEqual(["server:s1"]);
  });

  it("checks the server on the bare /api/servers/:id", async () => {
    const { run, calls } = makeContext({ method: "GET", path: "/api/servers/:id", params: { id: "s1" } });
    expect(await run()).toBe(true);
    expect(calls).toEqual(["server:s1"]);
  });

  it("accepts templates without the /api prefix", async () => {
    const { run, calls } = makeContext({ method: "GET", path: "/servers/:id", params: { id: "s1" } });
    expect(await run()).toBe(true);
    expect(calls).toEqual(["server:s1"]);
  });

  it("checks the cluster on /api/clusters/:id/action", async () => {
    const { run, calls } = makeContext({ method: "POST", path: "/api/clusters/:id/start", params: { id: "c1" } });
    expect(await run()).toBe(true);
    expect(calls).toEqual(["cluster:c1"]);
  });

  it("does not check routes without an :id (servers/stats)", async () => {
    const { run, calls } = makeContext({ method: "GET", path: "/api/servers/stats" });
    expect(await run()).toBe(true);
    expect(calls).toEqual([]);
  });

  it("leaves non-server routes with an :id to their handlers (schedules)", async () => {
    const { run, calls } = makeContext({ method: "PATCH", path: "/api/schedules/:id", params: { id: "sch1" } });
    expect(await run()).toBe(true);
    expect(calls).toEqual([]);
  });

  it("forbids creating servers (POST /servers and /servers/import)", async () => {
    await expect(makeContext({ method: "POST", path: "/api/servers" }).run()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(makeContext({ method: "POST", path: "/api/servers/import" }).run()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows listing servers with no check", async () => {
    const { run, calls } = makeContext({ method: "GET", path: "/api/servers" });
    expect(await run()).toBe(true);
    expect(calls).toEqual([]);
  });

  it("propagates a denied assertServer as NotFoundException", async () => {
    const { run, calls } = makeContext({
      method: "POST",
      path: "/api/servers/:id/stop",
      params: { id: "s2" },
      deny: ["s2"],
    });
    await expect(run()).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toEqual(["server:s2"]);
  });

  it("propagates a denied assertCluster as NotFoundException", async () => {
    const { run } = makeContext({ method: "DELETE", path: "/api/clusters/:id", params: { id: "c2" }, deny: ["c2"] });
    await expect(run()).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ServerAccessGuard.normalize", () => {
  it("strips only a leading /api segment", () => {
    expect(ServerAccessGuard.normalize("/api/servers/:id")).toBe("/servers/:id");
    expect(ServerAccessGuard.normalize("/api")).toBe("");
    expect(ServerAccessGuard.normalize("/servers/:id")).toBe("/servers/:id");
    expect(ServerAccessGuard.normalize("/apix/servers")).toBe("/apix/servers");
    expect(ServerAccessGuard.normalize(undefined)).toBe("");
  });
});
