import { describe, it, expect } from "vitest";
import { JwtService } from "@nestjs/jwt";
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
