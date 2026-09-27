import { describe, it, expect } from "vitest";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
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

// SSO sign-in maps a provider identity onto a Palisade user by its `sub` claim.
function makeOidcService(seed: { id: string; username: string; role: string; oidcSubject: string | null }[]) {
  const passwordHash = bcrypt.hashSync("hunter22", 4);
  const users = seed.map((u) => ({ ...u, tokenVersion: 0, restricted: false, passwordHash }));
  type U = (typeof users)[number];
  const find = (where: Partial<U>) =>
    users.find((u) => Object.entries(where).every(([k, v]) => u[k as keyof U] === v)) ?? null;
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: Partial<U> }) => find(where),
      findUniqueOrThrow: async ({ where }: { where: Partial<U> }) => find(where)!,
      count: async ({ where }: { where: { role: string; id: { not: string } } }) =>
        users.filter((u) => u.role === where.role && u.id !== where.id.not).length,
      create: async ({ data }: { data: Omit<U, "id" | "tokenVersion" | "restricted"> }) => {
        const u = { ...data, id: `u${users.length + 1}`, tokenVersion: 0, restricted: false };
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
  return { svc, users, roleIn };
}

describe("oidcSignIn", () => {
  it("creates a viewer on first sign-in when the provider does not manage roles", async () => {
    const { svc, users, roleIn } = makeOidcService([]);
    const { token } = await svc.oidcSignIn("sub-1", "alice", null);
    expect(users).toMatchObject([{ username: "alice", role: "viewer", oidcSubject: "sub-1" }]);
    expect(await roleIn(token)).toBe("viewer");
  });

  it("never takes over an account that merely shares the username", async () => {
    const { svc, users } = makeOidcService([{ id: "a", username: "magnus", role: "admin", oidcSubject: null }]);
    await svc.oidcSignIn("sub-1", "magnus", "admin");
    expect(users[0]!.oidcSubject).toBeNull();
    expect(users[1]).toMatchObject({ oidcSubject: "sub-1" });
    expect(users[1]!.username).toMatch(/^magnus_[0-9a-f]{6}$/);
  });

  it("follows the provider's role on every sign-in", async () => {
    const { svc, roleIn } = makeOidcService([
      { id: "a", username: "root", role: "admin", oidcSubject: null },
      { id: "b", username: "bob", role: "viewer", oidcSubject: "sub-b" },
    ]);
    expect(await roleIn((await svc.oidcSignIn("sub-b", "bob", "operator")).token)).toBe("operator");
    expect(await roleIn((await svc.oidcSignIn("sub-b", "bob", null)).token)).toBe("operator");
  });

  it("signs out sessions that still carry a role the provider changed", async () => {
    const { svc, users } = makeOidcService([
      { id: "a", username: "root", role: "admin", oidcSubject: null },
      { id: "b", username: "bob", role: "admin", oidcSubject: "sub-b" },
    ]);
    await svc.oidcSignIn("sub-b", "bob", "admin");
    expect(users[1]!.tokenVersion).toBe(0);
    const { token } = await svc.oidcSignIn("sub-b", "bob", "viewer");
    expect(users[1]!.tokenVersion).toBe(1);
    expect((new JwtService({ secret: "test-secret" }).decode(token) as { ver: number }).ver).toBe(1);
  });

  it("signs out a user the provider turned away, unless they are the last admin", async () => {
    const { svc, users } = makeOidcService([
      { id: "a", username: "root", role: "admin", oidcSubject: "sub-a" },
      { id: "b", username: "bob", role: "operator", oidcSubject: "sub-b" },
    ]);
    await svc.oidcRevoke("sub-b");
    await svc.oidcRevoke("sub-a");
    await svc.oidcRevoke("sub-unknown");
    expect(users.map((u) => u.tokenVersion)).toEqual([0, 1]);
  });

  it("does not demote the last admin", async () => {
    const { svc, roleIn } = makeOidcService([{ id: "a", username: "root", role: "admin", oidcSubject: "sub-a" }]);
    expect(await roleIn((await svc.oidcSignIn("sub-a", "root", "viewer")).token)).toBe("admin");
  });

  it("links an identity to one user only", async () => {
    const { svc, users } = makeOidcService([
      { id: "a", username: "root", role: "admin", oidcSubject: null },
      { id: "b", username: "bob", role: "viewer", oidcSubject: "sub-b" },
    ]);
    await svc.linkOidc("a", "sub-a", null);
    expect(users[0]!.oidcSubject).toBe("sub-a");
    await expect(svc.linkOidc("a", "sub-b", null)).rejects.toThrow(/different Palisade user/);
  });

  it("refuses a link that would demote the account at its next SSO sign-in", async () => {
    const { svc, users } = makeOidcService([{ id: "a", username: "root", role: "admin", oidcSubject: null }]);
    await expect(svc.linkOidc("a", "sub-a", "operator")).rejects.toThrow(/grant the operator role/);
    expect(users[0]!.oidcSubject).toBeNull();
    await svc.linkOidc("a", "sub-a", "admin");
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
    expect(users.map((u) => u.oidcSubject)).toEqual([null, null]);
  });
});
