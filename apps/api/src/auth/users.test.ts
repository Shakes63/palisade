import { describe, it, expect, vi } from "vitest";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "./auth.service";

// AuthService user management (GH #73): role defaults to operator, admins are
// never restricted, grants are replaced wholesale on update, and the panel can
// never be left without an admin.
interface Row {
  id: string;
  username: string;
  role: string;
  restricted: boolean;
  passwordHash?: string;
  tokenVersion?: number;
  createdAt?: Date;
}

function makeService(seed: Row[] = [], grants: { servers?: [string, string][]; clusters?: [string, string][] } = {}) {
  let nextId = 1;
  const users: Required<Row>[] = seed.map((r) => ({
    passwordHash: "x",
    tokenVersion: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...r,
  }));
  const serverAccess = (grants.servers ?? []).map(([userId, serverId]) => ({ userId, serverId }));
  const clusterAccess = (grants.clusters ?? []).map(([userId, clusterId]) => ({ userId, clusterId }));

  const joined = (u: Required<Row>) => ({
    ...u,
    serverAccess: serverAccess.filter((a) => a.userId === u.id).map(({ serverId }) => ({ serverId })),
    clusterAccess: clusterAccess.filter((a) => a.userId === u.id).map(({ clusterId }) => ({ clusterId })),
  });
  const find = (where: { id?: string; username?: string }) =>
    users.find((u) => (where.id !== undefined ? u.id === where.id : u.username === where.username));

  const prisma = {
    user: {
      findMany: async () => users.map(joined),
      findUnique: async ({ where }: { where: { id?: string; username?: string } }) => {
        const u = find(where);
        return u ? joined(u) : null;
      },
      count: async (args?: { where?: { role?: string; id?: { not: string } } }) =>
        users.filter(
          (u) =>
            (args?.where?.role === undefined || u.role === args.where.role) &&
            (args?.where?.id === undefined || u.id !== args.where.id.not),
        ).length,
      create: async ({
        data,
      }: {
        data: {
          username: string;
          passwordHash: string;
          role: string;
          restricted: boolean;
          serverAccess: { create: { serverId: string }[] };
          clusterAccess: { create: { clusterId: string }[] };
        };
      }) => {
        const u: Required<Row> = {
          id: `u${nextId++}`,
          username: data.username,
          passwordHash: data.passwordHash,
          role: data.role,
          restricted: data.restricted,
          tokenVersion: 0,
          createdAt: new Date("2026-02-02T00:00:00Z"),
        };
        users.push(u);
        for (const { serverId } of data.serverAccess.create) serverAccess.push({ userId: u.id, serverId });
        for (const { clusterId } of data.clusterAccess.create) clusterAccess.push({ userId: u.id, clusterId });
        return joined(u);
      },
      update: async ({ where, data }: { where: { id: string }; data: { role?: string; restricted?: boolean } }) => {
        const u = find(where)!;
        if (data.role !== undefined) u.role = data.role;
        if (data.restricted !== undefined) u.restricted = data.restricted;
        return joined(u);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const idx = users.findIndex((u) => u.id === where.id);
        return users.splice(idx, 1)[0];
      },
    },
    userServerAccess: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        for (let i = serverAccess.length - 1; i >= 0; i--) if (serverAccess[i]!.userId === where.userId) serverAccess.splice(i, 1);
      },
      createMany: async ({ data }: { data: { userId: string; serverId: string }[] }) => {
        serverAccess.push(...data);
      },
    },
    userClusterAccess: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        for (let i = clusterAccess.length - 1; i >= 0; i--) if (clusterAccess[i]!.userId === where.userId) clusterAccess.splice(i, 1);
      },
      createMany: async ({ data }: { data: { userId: string; clusterId: string }[] }) => {
        clusterAccess.push(...data);
      },
    },
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  const access = { notifyChanged: vi.fn() };
  const svc = new AuthService(prisma as never, new JwtService({ secret: "t" }), {} as never, access as never);
  return { svc, access, users, serverAccess, clusterAccess };
}

const admin = (id = "a1"): Row => ({ id, username: id, role: "admin", restricted: false });
const operator = (id = "o1"): Row => ({ id, username: id, role: "operator", restricted: false });

describe("AuthService.createUser", () => {
  it("defaults the role to operator and stores a bcrypt hash", async () => {
    const { svc, users } = makeService([admin()]);
    const dto = await svc.createUser("bob", "password123");
    expect(dto).toMatchObject({ username: "bob", role: "operator", restricted: false, serverIds: [], clusterIds: [] });
    expect(dto.createdAt).toBe("2026-02-02T00:00:00.000Z");
    const row = users.find((u) => u.username === "bob")!;
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it("ignores restricted and grants when creating an admin", async () => {
    const { svc, users, serverAccess, clusterAccess } = makeService([admin()]);
    const dto = await svc.createUser("root2", "password123", {
      role: "admin",
      restricted: true,
      serverIds: ["s1"],
      clusterIds: ["c1"],
    });
    expect(dto).toMatchObject({ role: "admin", restricted: false, serverIds: [], clusterIds: [] });
    expect(users.find((u) => u.username === "root2")!.restricted).toBe(false);
    expect(serverAccess).toEqual([]);
    expect(clusterAccess).toEqual([]);
  });

  it("stores grants for a restricted user", async () => {
    const { svc, serverAccess, clusterAccess } = makeService([admin()]);
    const dto = await svc.createUser("carol", "password123", {
      role: "viewer",
      restricted: true,
      serverIds: ["s1", "s2"],
      clusterIds: ["c1"],
    });
    expect(dto).toMatchObject({ role: "viewer", restricted: true, serverIds: ["s1", "s2"], clusterIds: ["c1"] });
    expect(serverAccess.map((a) => a.serverId)).toEqual(["s1", "s2"]);
    expect(clusterAccess.map((a) => a.clusterId)).toEqual(["c1"]);
  });

  it("rejects short passwords, empty usernames and duplicates without hashing", async () => {
    const { svc } = makeService([admin()]);
    await expect(svc.createUser("x", "short")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createUser("", "password123")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createUser("a1", "password123")).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("AuthService.updateUser", () => {
  it("replaces grants wholesale, dedupes ids and notifies AccessService", async () => {
    const { svc, access, serverAccess, clusterAccess } = makeService([admin(), operator()], {
      servers: [["o1", "old"], ["a1", "keep"]],
      clusters: [["o1", "oldc"]],
    });
    const dto = await svc.updateUser("o1", { restricted: true, serverIds: ["s1", "s1", "s2"], clusterIds: ["c1", "c1"] });
    expect(dto).toMatchObject({ restricted: true, serverIds: ["s1", "s2"], clusterIds: ["c1"] });
    expect(serverAccess).toEqual([
      { userId: "a1", serverId: "keep" },
      { userId: "o1", serverId: "s1" },
      { userId: "o1", serverId: "s2" },
    ]);
    expect(clusterAccess).toEqual([{ userId: "o1", clusterId: "c1" }]);
    expect(access.notifyChanged).toHaveBeenCalledWith("o1");
  });

  it("leaves grants alone when serverIds/clusterIds are omitted", async () => {
    const { svc, serverAccess } = makeService([admin(), operator()], { servers: [["o1", "s1"]] });
    const dto = await svc.updateUser("o1", { role: "viewer" });
    expect(dto).toMatchObject({ role: "viewer", serverIds: ["s1"] });
    expect(serverAccess).toEqual([{ userId: "o1", serverId: "s1" }]);
  });

  it("refuses to demote the only admin", async () => {
    const { svc, access, users } = makeService([admin(), operator()]);
    await expect(svc.updateUser("a1", { role: "operator" })).rejects.toBeInstanceOf(BadRequestException);
    expect(users.find((u) => u.id === "a1")!.role).toBe("admin");
    expect(access.notifyChanged).not.toHaveBeenCalled();
  });

  it("demotes an admin when another admin remains", async () => {
    const { svc, users } = makeService([admin("a1"), admin("a2")]);
    const dto = await svc.updateUser("a1", { role: "operator" });
    expect(dto.role).toBe("operator");
    expect(users.find((u) => u.id === "a1")!.role).toBe("operator");
  });

  it("404s an unknown user", async () => {
    const { svc } = makeService([admin()]);
    await expect(svc.updateUser("ghost", { role: "viewer" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("AuthService.deleteUser", () => {
  it("refuses to delete the last user", async () => {
    const { svc, users } = makeService([admin()]);
    await expect(svc.deleteUser("a1")).rejects.toBeInstanceOf(BadRequestException);
    expect(users).toHaveLength(1);
  });

  it("refuses to delete the only admin", async () => {
    const { svc, users } = makeService([admin(), operator()]);
    await expect(svc.deleteUser("a1")).rejects.toBeInstanceOf(BadRequestException);
    expect(users).toHaveLength(2);
  });

  it("deletes a non-admin and an admin who is not the last one", async () => {
    const { svc, users } = makeService([admin("a1"), admin("a2"), operator()]);
    expect(await svc.deleteUser("o1")).toEqual({ ok: true });
    expect(await svc.deleteUser("a2")).toEqual({ ok: true });
    expect(users.map((u) => u.id)).toEqual(["a1"]);
  });
});

describe("AuthService.listUsers / me", () => {
  it("reports restricted=false for admins even when the column is true", async () => {
    const { svc } = makeService(
      [
        { id: "a1", username: "a1", role: "admin", restricted: true },
        { id: "o1", username: "o1", role: "operator", restricted: true },
      ],
      { servers: [["a1", "s1"]] },
    );
    const list = await svc.listUsers();
    expect(list.map((u) => [u.id, u.restricted])).toEqual([
      ["a1", false],
      ["o1", true],
    ]);
    // Stale grants on an admin row are still surfaced; only the flag is masked.
    expect(list[0]!.serverIds).toEqual(["s1"]);
    expect((await svc.me("a1")).restricted).toBe(false);
  });

  it("me() throws UnauthorizedException for an unknown id", async () => {
    const { svc } = makeService([admin()]);
    await expect(svc.me("ghost")).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
