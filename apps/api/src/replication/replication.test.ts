import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventType } from "@ark/shared";
import { ReplicationService } from "./replication.service";

const execFileP = promisify(execFile);

/**
 * Real tar + real files against a "local" destination. The point under test is the
 * race with retention (GH #65): a snapshot directory can vanish while tar is
 * reading it, which must not abort the sync or leave a half-written artifact.
 */
describe("ReplicationService", () => {
  let root: string;
  let target: string;
  let snapshots: { serverId: string; path: string; server: { name: string; game: string; backupKeep: number | null } }[];
  let emitted: { type: EventType; message: string }[];
  let svc: ReplicationService;

  beforeEach(async () => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
    root = await mkdtemp(join(tmpdir(), "palisade-repl-"));
    process.env.DATA_DIR = join(root, "data");
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
    target = join(root, "target");
    await mkdir(target, { recursive: true });
    snapshots = [];
    emitted = [];
    const config = JSON.stringify({ enabled: true, kind: "local", dir: target });
    const settings = {
      get: async (key: string) => (key === "backup_replication" ? config : null),
      set: async () => undefined,
    };
    const prisma = { snapshot: { findMany: async () => snapshots } };
    const events = {
      onEvent: () => undefined,
      emit: async (e: { type: EventType; message: string }) => {
        emitted.push(e);
      },
    };
    svc = new ReplicationService(prisma as never, events as never, settings as never);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
  });

  async function snapshot(serverId: string, name: string): Promise<string> {
    const path = join(root, "data", "backups", serverId, name);
    await mkdir(join(path, "world"), { recursive: true });
    await writeFile(join(path, "world", "level.dat"), `save ${name}`);
    snapshots.push({ serverId, path, server: { name: "Test", game: "MINECRAFT", backupKeep: 5 } });
    return path;
  }

  it("uploads each snapshot as a .tar.gz the target can list back", async () => {
    await snapshot("srv1", "scheduled-2026-09-07T10-45-00-000Z");
    const result = await svc.sync();
    expect(result).toEqual({ uploaded: 1, skipped: false });
    const files = await readdir(join(target, "srv1"));
    expect(files).toContain("scheduled-2026-09-07T10-45-00-000Z.tar.gz");
    const { stdout } = await execFileP("tar", ["tzf", join(target, "srv1", "scheduled-2026-09-07T10-45-00-000Z.tar.gz")]);
    expect(stdout).toContain("./world/level.dat");
    expect(emitted).toEqual([]);
  });

  it("treats a snapshot deleted underneath tar as gone, not as a failed sync", async () => {
    const doomed = join(root, "data", "backups", "srv1", "scheduled-2026-09-07T07-45-00-123Z");
    const artifact = join(target, "srv1", "scheduled-2026-09-07T07-45-00-123Z.tar.gz");
    await mkdir(join(target, "srv1"), { recursive: true });
    // Directly exercise the tar path with a directory that is already gone — what
    // tar sees when retention wins the race after the pre-flight exists() check.
    const { LocalDestination } = await import("./replication.service");
    const landed = await (svc as unknown as {
      uploadTarGz: (dir: string, dest: InstanceType<typeof LocalDestination>, remote: string) => Promise<boolean>;
    }).uploadTarGz(doomed, new LocalDestination(), artifact);
    expect(landed).toBe(false);
    await expect(stat(artifact)).rejects.toThrow(); // no half-written artifact left behind
  });

  it("keeps going past a vanished snapshot and still replicates the rest", async () => {
    const older = await snapshot("srv1", "scheduled-2026-09-07T07-45-00-123Z");
    await snapshot("srv1", "scheduled-2026-09-07T16-45-04-609Z");
    const real = (svc as unknown as { uploadTarGz: (...a: unknown[]) => Promise<boolean> }).uploadTarGz.bind(svc);
    // Retention deletes the older snapshot the instant its upload begins.
    vi.spyOn(svc as unknown as { uploadTarGz: (...a: unknown[]) => Promise<boolean> }, "uploadTarGz").mockImplementation(
      async (...args: unknown[]) => {
        if (args[0] === older) await rm(older, { recursive: true, force: true });
        return real(...args);
      },
    );
    const result = await svc.sync();
    expect(result).toEqual({ uploaded: 1, skipped: false });
    const files = await readdir(join(target, "srv1"));
    expect(files).toContain("scheduled-2026-09-07T16-45-04-609Z.tar.gz");
    expect(files).not.toContain("scheduled-2026-09-07T07-45-00-123Z.tar.gz");
    expect(emitted.filter((e) => e.type === EventType.Warning)).toEqual([]);
  });

  it("still reports a genuine tar failure, with tar's complaint attached", async () => {
    const path = await snapshot("srv1", "scheduled-2026-09-07T10-45-00-000Z");
    await mkdir(join(path, "unreadable"));
    await writeFile(join(path, "unreadable", "secret"), "x", { mode: 0o000 });
    if (process.getuid?.() === 0) return; // root reads anything — nothing to provoke
    await expect(svc.sync()).rejects.toThrow(/tar exited \d+ .*Permission denied/);
    expect(emitted.some((e) => e.type === EventType.Warning && /Permission denied/.test(e.message))).toBe(true);
    await expect(stat(join(target, "srv1", "scheduled-2026-09-07T10-45-00-000Z.tar.gz"))).rejects.toThrow();
  });
});
