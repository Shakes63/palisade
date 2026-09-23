import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { chmod, mkdtemp, mkdir, rm, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { FilesService } from "./files.service";

/** Real-filesystem tests: the sandbox is the security boundary, so it's exercised
 *  with actual symlinks + traversal attempts, not mocks. */
describe("FilesService", () => {
  let dataDir: string;
  let root: string; // the server's instance dir
  let outside: string; // a sibling dir that must be unreachable
  let svc: FilesService;

  beforeAll(() => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "palisade-files-"));
    process.env.DATA_DIR = dataDir;
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
    root = join(dataDir, "instances", "srv1");
    outside = join(dataDir, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "host-secret");
    await writeFile(join(root, "server.cfg"), "port=1234\n");
    await mkdir(join(root, "mods"), { recursive: true });
    await writeFile(join(root, "mods", "a.txt"), "aaa");
    const prisma = { server: { findUnique: async () => ({ id: "srv1" }) } };
    svc = new FilesService(prisma as never);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
  });

  // ── the security boundary ────────────────────────────────────────────────────
  it("rejects ../ traversal, absolute paths, and null bytes", async () => {
    for (const evil of ["../outside/secret.txt", "..", "mods/../../outside/secret.txt", "/etc/passwd", "a\0b"]) {
      await expect(svc.readText("srv1", evil), evil).rejects.toThrow(BadRequestException);
    }
  });

  it("rejects reads/writes through a symlink that escapes the root", async () => {
    await symlink(outside, join(root, "sneaky"));
    await expect(svc.readText("srv1", "sneaky/secret.txt")).rejects.toThrow(/symlink/i);
    await expect(svc.writeText("srv1", "sneaky/planted.txt", "x")).rejects.toThrow(/symlink/i);
    await expect(svc.list("srv1", "sneaky")).rejects.toThrow(/symlink/i);
  });

  it("rejects a symlinked FILE pointing outside the root", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
    await expect(svc.readText("srv1", "leak.txt")).rejects.toThrow(/symlink/i);
  });

  it("refuses to delete or rename the server root itself", async () => {
    await expect(svc.remove("srv1", ".")).rejects.toThrow(/root/i);
    await expect(svc.rename("srv1", ".", "mods/x")).rejects.toThrow(/root/i);
  });

  // ── normal operation ─────────────────────────────────────────────────────────
  it("lists directories with dirs first", async () => {
    const { entries } = await svc.list("srv1", ".");
    expect(entries.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:mods", "file:server.cfg"]);
  });

  it("reads and writes text files", async () => {
    expect((await svc.readText("srv1", "server.cfg")).content).toBe("port=1234\n");
    await svc.writeText("srv1", "server.cfg", "port=9999\n");
    expect(await readFile(join(root, "server.cfg"), "utf8")).toBe("port=9999\n");
  });

  it("refuses to open binary files in the editor", async () => {
    await writeFile(join(root, "world.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    await expect(svc.readText("srv1", "world.bin")).rejects.toThrow(/binary/i);
  });

  it("refuses oversized files in the editor but still serves them for download", async () => {
    await writeFile(join(root, "big.log"), Buffer.alloc(3 * 1024 * 1024, 97));
    await expect(svc.readText("srv1", "big.log")).rejects.toThrow(/too large/i);
    const dl = await svc.downloadPath("srv1", "big.log");
    expect(dl.size).toBe(3 * 1024 * 1024);
    expect(dl.name).toBe("big.log");
  });

  it("uploads strip any path from the client filename", async () => {
    await svc.upload("srv1", "mods", "../../../../etc/evil.txt", Buffer.from("x"));
    const { entries } = await svc.list("srv1", "mods");
    expect(entries.map((e) => e.name)).toContain("evil.txt"); // basename only, inside mods/
    await expect(svc.readText("srv1", "mods/evil.txt")).resolves.toMatchObject({ content: "x" });
  });

  it("mkdir, rename, and delete stay inside the sandbox", async () => {
    await svc.mkdir("srv1", "cfg/backup");
    await svc.rename("srv1", "mods/a.txt", "cfg/backup/a.txt");
    expect((await svc.list("srv1", "cfg/backup")).entries.map((e) => e.name)).toEqual(["a.txt"]);
    await svc.remove("srv1", "cfg");
    await expect(svc.list("srv1", "cfg")).rejects.toThrow(/not a directory/i);
    await expect(svc.rename("srv1", "mods/a.txt", "../../outside/a.txt")).rejects.toThrow(BadRequestException);
  });

  // Root reads everything, so the case can only be reproduced as another user.
  it.skipIf(process.getuid?.() === 0)("turns an unreadable folder into a 403, not a bare 500", async () => {
    await chmod(join(root, "server.cfg"), 0o000);
    await chmod(join(root, "mods"), 0o000);
    try {
      await expect(svc.list("srv1", "mods")).rejects.toThrow(ForbiddenException);
      await expect(svc.readText("srv1", "server.cfg")).rejects.toThrow(/permission denied/i);
    } finally {
      await chmod(join(root, "mods"), 0o755);
    }
  });
});
