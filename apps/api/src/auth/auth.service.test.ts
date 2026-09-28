import { describe, it, expect } from "vitest";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { AuthService } from "./auth.service";

// Token revocation: every JWT carries a `ver` claim frozen at sign time; the
// guard rejects any token whose ver no longer matches User.tokenVersion. A
// logout-all just increments the version — no token denylist needed.
function makeService(users: Record<string, { tokenVersion: number }>) {
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = users[where.id];
        return user ? { tokenVersion: user.tokenVersion, restricted: false } : null;
      },
      update: async ({ where }: { where: { id: string } }) => {
        const user = users[where.id]!;
        user.tokenVersion += 1;
        return user;
      },
    },
  };
  const jwt = new JwtService({ secret: "test-secret" });
  return new AuthService(prisma as never, jwt, {} as never, {} as never);
}

describe("token revocation (tokenVersion)", () => {
  it("accepts a token whose ver matches the stored version", async () => {
    const svc = makeService({ u1: { tokenVersion: 3 } });
    expect(await svc.isTokenCurrent("u1", 3)).toBe(true);
  });

  it("rejects when the stored version has moved on", async () => {
    const svc = makeService({ u1: { tokenVersion: 4 } });
    expect(await svc.isTokenCurrent("u1", 3)).toBe(false);
  });

  it("rejects legacy tokens with no ver claim and unknown users", async () => {
    const svc = makeService({ u1: { tokenVersion: 0 } });
    expect(await svc.isTokenCurrent("u1", undefined)).toBe(false);
    expect(await svc.isTokenCurrent("ghost", 0)).toBe(false);
    expect(await svc.isTokenCurrent(undefined, 0)).toBe(false);
  });

  it("logoutAll invalidates previously current tokens", async () => {
    const users = { u1: { tokenVersion: 0 } };
    const svc = makeService(users);
    expect(await svc.isTokenCurrent("u1", 0)).toBe(true);
    await svc.logoutAll("u1");
    expect(await svc.isTokenCurrent("u1", 0)).toBe(false);
    expect(await svc.isTokenCurrent("u1", 1)).toBe(true);
  });
});

// SSO sign-in maps a provider identity onto a Palisade user by its issuer and `sub` claim.
const ISS = "https://auth.example.com";
const sso = (subject: string, issuer = ISS) => ({ issuer, subject });

type Seed = { id: string; username: string; role: string; oidcSubject: string | null; hasPassword?: boolean };
function makeOidcService(seed: Seed[]) {
  const passwordHash = bcrypt.hashSync("hunter22", 4);
  const users = seed.map((u) => ({
    hasPassword: true,
    ...u,
    oidcIssuer: u.oidcSubject === null ? null : ISS,
    tokenVersion: 0,
    restricted: false,
    passwordHash,
  }));
  type U = (typeof users)[number];
  const find = (where: Partial<U>) =>
    users.find((u) => Object.entries(where).every(([k, v]) => u[k as keyof U] === v)) ?? null;
  const unique = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: Partial<U> }) => find(where),
      findFirst: async ({ where }: { where: Partial<U> }) => find(where),
      findUniqueOrThrow: async ({ where }: { where: Partial<U> }) => find(where)!,
      count: async ({ where }: { where: { role: string; id: { not: string } } }) =>
        users.filter((u) => u.role === where.role && u.id !== where.id.not).length,
      create: async ({ data }: { data: Omit<U, "id" | "tokenVersion"> }) => {
        if (find({ username: data.username }) || find({ oidcIssuer: data.oidcIssuer, oidcSubject: data.oidcSubject })) {
          throw unique;
        }
        const u = { ...data, id: `u${users.length + 1}`, tokenVersion: 0 };
        users.push(u);
        return u;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = find(where)!;
        const { tokenVersion, ...rest } = data as { tokenVersion?: { increment: number } };
        if (tokenVersion) u.tokenVersion += tokenVersion.increment;
        return Object.assign(u, rest);
      },
    },
  };
  const svc = new AuthService(prisma as never, new JwtService({ secret: "test-secret" }), {} as never, {} as never);
  // Role edits go through updateUser; its transaction/grant handling is covered elsewhere.
  svc.updateUser = async (id, { role }) => {
    Object.assign(find({ id })!, { role });
    return {} as never;
  };
  const roleIn = async (token: string) => (new JwtService({ secret: "test-secret" }).decode(token) as { role: string }).role;
  return { svc, users, prisma, roleIn };
}

describe("oidcSignIn", () => {
  it("creates a restricted viewer on first sign-in when the provider does not manage roles", async () => {
    const { svc, users, roleIn } = makeOidcService([]);
    const { token } = await svc.oidcSignIn(sso("sub-1"), "alice", null, true);
    expect(users).toMatchObject([
      { username: "alice", role: "viewer", restricted: true, hasPassword: false, oidcIssuer: ISS, oidcSubject: "sub-1" },
    ]);
    expect(await roleIn(token)).toBe("viewer");
  });

  it("gives a new user the role the provider's groups grant", async () => {
    const { svc, users } = makeOidcService([]);
    await svc.oidcSignIn(sso("sub-1"), "alice", "operator", true);
    expect(users).toMatchObject([{ role: "operator", restricted: false }]);
  });

  it("turns away an unlinked identity unless SSO may create accounts", async () => {
    const { svc, users } = makeOidcService([]);
    await expect(svc.oidcSignIn(sso("sub-1"), "alice", "admin", false)).rejects.toThrow(/No Palisade account is linked/);
    expect(users).toEqual([]);
  });

  it("never matches a subject from another issuer", async () => {
    const { svc, users } = makeOidcService([{ id: "a", username: "root", role: "admin", oidcSubject: "1" }]);
    await expect(svc.oidcSignIn(sso("1", "https://other.example.com"), "root", null, false)).rejects.toThrow(
      /No Palisade account/,
    );
    await svc.oidcSignIn(sso("1", "https://other.example.com"), "mallory", null, true);
    expect(users[1]).toMatchObject({ username: "mallory", role: "viewer", oidcIssuer: "https://other.example.com" });
  });

  it("never takes over an account that merely shares the username", async () => {
    const { svc, users } = makeOidcService([{ id: "a", username: "magnus", role: "admin", oidcSubject: null }]);
    await svc.oidcSignIn(sso("sub-1"), "magnus", "admin", true);
    expect(users[0]!.oidcSubject).toBeNull();
    expect(users[1]).toMatchObject({ oidcSubject: "sub-1" });
    expect(users[1]!.username).toMatch(/^magnus_[0-9a-f]{6}$/);
  });

  it("signs in the account a concurrent callback created instead of failing", async () => {
    const { svc, users, prisma } = makeOidcService([]);
    const create = prisma.user.create;
    // The other callback wins the race between the lookup and the insert.
    prisma.user.create = async (args) => {
      await create({ data: { ...args.data, username: "alice" } });
      return create(args);
    };
    const { token } = await svc.oidcSignIn(sso("sub-1"), "alice", null, true);
    expect(users).toHaveLength(1);
    expect((new JwtService({ secret: "test-secret" }).decode(token) as { sub: string }).sub).toBe(users[0]!.id);
  });

  it("follows the provider's role on every sign-in", async () => {
    const { svc, roleIn } = makeOidcService([
      { id: "a", username: "root", role: "admin", oidcSubject: null },
      { id: "b", username: "bob", role: "viewer", oidcSubject: "sub-b" },
    ]);
    expect(await roleIn((await svc.oidcSignIn(sso("sub-b"), "bob", "operator", false)).token)).toBe("operator");
    expect(await roleIn((await svc.oidcSignIn(sso("sub-b"), "bob", null, false)).token)).toBe("operator");
  });

  it("signs out sessions that still carry a role the provider changed", async () => {
    const { svc, users } = makeOidcService([
      { id: "a", username: "root", role: "admin", oidcSubject: null },
      { id: "b", username: "bob", role: "admin", oidcSubject: "sub-b" },
    ]);
    await svc.oidcSignIn(sso("sub-b"), "bob", "admin", false);
    expect(users[1]!.tokenVersion).toBe(0);
    const { token } = await svc.oidcSignIn(sso("sub-b"), "bob", "viewer", false);
    expect(users[1]!.tokenVersion).toBe(1);
    expect((new JwtService({ secret: "test-secret" }).decode(token) as { ver: number }).ver).toBe(1);
  });

  it("signs out a user the provider turned away, unless they are the last admin", async () => {
    const { svc, users } = makeOidcService([
      { id: "a", username: "root", role: "admin", oidcSubject: "sub-a" },
      { id: "b", username: "bob", role: "operator", oidcSubject: "sub-b" },
    ]);
    await svc.oidcRevoke(sso("sub-b"));
    await svc.oidcRevoke(sso("sub-a"));
    await svc.oidcRevoke(sso("sub-unknown"));
    expect(users.map((u) => u.tokenVersion)).toEqual([0, 1]);
  });

  it("does not demote the last admin", async () => {
    const { svc, roleIn } = makeOidcService([{ id: "a", username: "root", role: "admin", oidcSubject: "sub-a" }]);
    expect(await roleIn((await svc.oidcSignIn(sso("sub-a"), "root", "viewer", false)).token)).toBe("admin");
  });

  it("links an identity to one user only", async () => {
    const { svc, users } = makeOidcService([
      { id: "a", username: "root", role: "admin", oidcSubject: null },
      { id: "b", username: "bob", role: "viewer", oidcSubject: "sub-b" },
    ]);
    await svc.linkOidc("a", sso("sub-a"), null);
    expect(users[0]).toMatchObject({ oidcIssuer: ISS, oidcSubject: "sub-a" });
    await expect(svc.linkOidc("a", sso("sub-b"), null)).rejects.toThrow(/different Palisade user/);
  });

  it("refuses a link that would demote the account at its next SSO sign-in", async () => {
    const { svc, users } = makeOidcService([{ id: "a", username: "root", role: "admin", oidcSubject: null }]);
    await expect(svc.linkOidc("a", sso("sub-a"), "operator")).rejects.toThrow(/grant the operator role/);
    expect(users[0]!.oidcSubject).toBeNull();
    await svc.linkOidc("a", sso("sub-a"), "admin");
    expect(users[0]!.oidcSubject).toBe("sub-a");
  });

  it("unlinks yourself only with your password", async () => {
    const { svc, users } = makeOidcService([
      { id: "a", username: "root", role: "admin", oidcSubject: "sub-a" },
      { id: "b", username: "bob", role: "viewer", oidcSubject: "sub-b" },
    ]);
    await expect(svc.unlinkOidc("a", "wrong-password")).rejects.toThrow(/Wrong password/);
    expect(users[0]!.oidcSubject).toBe("sub-a");
    await svc.unlinkOidc("a", "hunter22");
    await svc.unlinkOidc("b");
    expect(users.map((u) => [u.oidcIssuer, u.oidcSubject])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("never unlinks an account SSO created, which has no password to fall back on", async () => {
    const { svc, users } = makeOidcService([
      { id: "a", username: "alice", role: "viewer", oidcSubject: "sub-a", hasPassword: false },
    ]);
    await expect(svc.unlinkOidc("a")).rejects.toThrow(/created through SSO/);
    expect(users[0]!.oidcSubject).toBe("sub-a");
  });
});
