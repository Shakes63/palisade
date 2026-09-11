import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { AccessService } from "./access.service";
import type { AuthUser } from "./auth-user";

// Per-user server/cluster visibility (GH #73). Admins and unrestricted users
// see "all"; a restricted user sees direct grants plus the members of any
// granted cluster, resolved fresh on every call so membership edits apply
// without touching the grant.
interface Fixture {
  /** userId -> directly granted server ids */
  serverGrants?: Record<string, string[]>;
  /** userId -> directly granted cluster ids */
  clusterGrants?: Record<string, string[]>;
  /** clusterId -> member server ids (mutable: tests add members mid-flight) */
  clusters?: Record<string, string[]>;
}

function makeService(fx: Fixture = {}) {
  const clusters = fx.clusters ?? {};
  const prisma = {
    userServerAccess: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        (fx.serverGrants?.[where.userId] ?? []).map((serverId) => ({ serverId })),
    },
    userClusterAccess: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        (fx.clusterGrants?.[where.userId] ?? []).map((clusterId) => ({ clusterId })),
    },
    server: {
      findMany: async ({ where }: { where: { clusterId: { in: string[] } } }) =>
        where.clusterId.in.flatMap((cid) => (clusters[cid] ?? []).map((id) => ({ id }))),
    },
    cluster: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id in clusters ? { servers: clusters[where.id]!.map((id) => ({ id })) } : null,
    },
  };
  return { svc: new AccessService(prisma as never), clusters };
}

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  sub: "u1",
  ver: 0,
  role: "operator",
  restricted: false,
  ...over,
});

const restricted = (over: Partial<AuthUser> = {}) => user({ restricted: true, ...over });

const ids = (allowed: "all" | Set<string>) => (allowed === "all" ? "all" : [...allowed].sort());

describe("AccessService.allowedServerIds", () => {
  it("admins see everything regardless of the restricted flag", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1"] } });
    expect(await svc.allowedServerIds(user({ role: "admin", restricted: true }))).toBe("all");
    expect(await svc.allowedServerIds(user({ role: "admin", restricted: false }))).toBe("all");
  });

  it("an unrestricted non-admin sees everything", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1"] } });
    expect(await svc.allowedServerIds(user({ role: "viewer" }))).toBe("all");
    expect(await svc.allowedServerIds(user({ role: "operator" }))).toBe("all");
  });

  it("legacy tokens with no role claim count as admin", async () => {
    const { svc } = makeService();
    expect(await svc.allowedServerIds(user({ role: undefined, restricted: true }))).toBe("all");
    expect(await svc.allowedServerIds(undefined)).toBe("all");
  });

  it("a restricted user sees only direct grants", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1", "s2"], u2: ["s3"] } });
    expect(ids(await svc.allowedServerIds(restricted()))).toEqual(["s1", "s2"]);
    expect(ids(await svc.allowedServerIds(restricted({ sub: "u3" })))).toEqual([]);
  });

  it("a cluster grant expands to its members and follows later membership changes", async () => {
    const { svc, clusters } = makeService({
      serverGrants: { u1: ["s1"] },
      clusterGrants: { u1: ["c1"] },
      clusters: { c1: ["s2", "s3"], c2: ["s4"] },
    });
    expect(ids(await svc.allowedServerIds(restricted()))).toEqual(["s1", "s2", "s3"]);

    clusters.c1!.push("s9");
    expect(ids(await svc.allowedServerIds(restricted()))).toEqual(["s1", "s2", "s3", "s9"]);
  });
});

describe("AccessService.canSeeServer / canUseCluster", () => {
  it("canSeeServer reflects the allowed set", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1"] } });
    expect(await svc.canSeeServer(restricted(), "s1")).toBe(true);
    expect(await svc.canSeeServer(restricted(), "s2")).toBe(false);
    expect(await svc.canSeeServer(user({ role: "admin" }), "s2")).toBe(true);
  });

  it("a directly granted cluster is usable", async () => {
    const { svc } = makeService({ clusterGrants: { u1: ["c1"] }, clusters: { c1: ["s1", "s2"] } });
    expect(await svc.canUseCluster(restricted(), "c1")).toBe(true);
  });

  it("a cluster whose every member is directly granted is usable", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1", "s2"] }, clusters: { c1: ["s1", "s2"] } });
    expect(await svc.canUseCluster(restricted(), "c1")).toBe(true);
  });

  it("a cluster with only some members visible is not usable", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1"] }, clusters: { c1: ["s1", "s2"] } });
    expect(await svc.canUseCluster(restricted(), "c1")).toBe(false);
  });

  it("an unknown cluster is not usable; unrestricted users skip the lookup", async () => {
    const { svc } = makeService({ clusters: {} });
    expect(await svc.canUseCluster(restricted(), "ghost")).toBe(false);
    expect(await svc.canUseCluster(user(), "ghost")).toBe(true);
  });

  it("grantedClusterIds lists only direct cluster grants", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1", "s2"] }, clusterGrants: { u1: ["c2"] }, clusters: { c1: ["s1", "s2"], c2: ["s3"] } });
    expect(ids(await svc.grantedClusterIds(restricted()))).toEqual(["c2"]);
    expect(await svc.grantedClusterIds(user())).toBe("all");
  });
});

describe("AccessService.assert*", () => {
  it("assertServer denies with NotFoundException so hidden and missing look the same", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1"] } });
    await expect(svc.assertServer(restricted(), "s1")).resolves.toBeUndefined();
    await expect(svc.assertServer(restricted(), "s2")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("assertCluster denies with NotFoundException", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1"] }, clusters: { c1: ["s1", "s2"] } });
    await expect(svc.assertCluster(restricted(), "c1")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.assertCluster(user({ role: "admin" }), "c1")).resolves.toBeUndefined();
  });

  it("assertServers fails on the first hidden id and passes an all-visible list", async () => {
    const { svc } = makeService({ serverGrants: { u1: ["s1", "s3"] } });
    await expect(svc.assertServers(restricted(), ["s1", "s3"])).resolves.toBeUndefined();
    await expect(svc.assertServers(restricted(), ["s1", "s2", "s4"])).rejects.toMatchObject({
      message: "Server s2 not found",
    });
    await expect(svc.assertServers(user(), ["s2", "s4"])).resolves.toBeUndefined();
  });
});

describe("AccessService.filterByServer", () => {
  const rows = [
    { id: "a", serverId: "s1" },
    { id: "b", serverId: null },
    { id: "c", serverId: "s2" },
  ];

  it("passes everything through for 'all'", () => {
    const { svc } = makeService();
    expect(svc.filterByServer(rows, "all")).toBe(rows);
  });

  it("drops null serverIds and hidden ids", () => {
    const { svc } = makeService();
    expect(svc.filterByServer(rows, new Set(["s1"])).map((r) => r.id)).toEqual(["a"]);
    expect(svc.filterByServer(rows, new Set())).toEqual([]);
  });
});

describe("AccessService change notifications", () => {
  it("onChanged receives notifyChanged userIds until unsubscribed", () => {
    const { svc } = makeService();
    const listener = vi.fn();
    const off = svc.onChanged(listener);

    svc.notifyChanged("u1");
    svc.notifyChanged("u2");
    expect(listener.mock.calls).toEqual([["u1"], ["u2"]]);

    off();
    svc.notifyChanged("u3");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
