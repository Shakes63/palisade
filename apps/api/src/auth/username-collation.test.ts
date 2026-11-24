import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JwtService } from "@nestjs/jwt";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthService } from "./auth.service";

// Case-insensitive usernames live in the database's collation, which a fake can't show, so this runs the migrations.
describe("usernames on a migrated database", () => {
  const dir = mkdtempSync(join(tmpdir(), "palisade-users-"));
  const url = `file:${join(dir, "db.sqlite")}`;
  let prisma: PrismaClient;
  let svc: AuthService;

  beforeAll(async () => {
    execFileSync(resolve(__dirname, "../../node_modules/.bin/prisma"), ["migrate", "deploy"], {
      cwd: resolve(__dirname, "../.."),
      env: { ...process.env, DATABASE_URL: url },
      stdio: "ignore",
    });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    svc = new AuthService(prisma as never, new JwtService({ secret: "test-secret" }), {} as never, {} as never);
    await svc.createUser("Magnus", "password123");
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a name that differs from an existing one only by case", async () => {
    await expect(svc.createUser("magnus", "password123")).rejects.toThrow("Username already taken");
    await expect(
      prisma.user.create({ data: { username: "MAGNUS", passwordHash: "x" } }),
    ).rejects.toSatisfy((e) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002");
  });

  it("signs in whatever case is typed, ignoring surrounding spaces", async () => {
    const { token } = await svc.login({ username: " mAGNUS ", password: "password123" });
    const { username } = new JwtService({ secret: "test-secret" }).decode(token) as { username: string };
    expect(username).toBe("Magnus");
  });

  it("gives an SSO account a fresh name when its name differs from a taken one only by case", async () => {
    await svc.oidcSignIn({ issuer: "https://idp", subject: "sub-1" }, "MAGNUS", null, true);
    const sso = await prisma.user.findFirstOrThrow({ where: { oidcSubject: "sub-1" } });
    expect(sso.username).toMatch(/^MAGNUS_[0-9a-f]{6}$/);
  });

  it("matches an SSO sign-in to the account of its name whatever the case, when the admin opts in", async () => {
    await svc.createUser("Bob", "password123", { role: "viewer" });
    await svc.oidcSignIn({ issuer: "https://idp", subject: "sub-2" }, "bob", null, false, true);
    expect(await prisma.user.findUniqueOrThrow({ where: { username: "BOB" } })).toMatchObject({ oidcSubject: "sub-2" });
  });
});
