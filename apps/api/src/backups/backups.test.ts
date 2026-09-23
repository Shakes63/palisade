import { describe, it, expect, vi } from "vitest";
import { includeInBackup } from "./backups.service";

// A backup keeps the live world + config + players/tribes, and drops ARK's own
// rolling dated dupes (.ark/.arkrbf), its anti-corruption .bak, and Logs/Cache —
// which is what shrinks a snapshot from ~1.3 GB to ~the live world.
describe("includeInBackup", () => {
  it("keeps the live world, config, and player/tribe data", () => {
    expect(includeInBackup("SavedArks/TheIsland_WP/TheIsland_WP.ark")).toBe(true);
    expect(includeInBackup("Config/WindowsServer/Game.ini")).toBe(true);
    expect(includeInBackup("Config/WindowsServer/GameUserSettings.ini")).toBe(true);
    expect(includeInBackup("SavedArks/TheIsland_WP/0002e9f9.arkprofile")).toBe(true);
    expect(includeInBackup("SavedArks/TheIsland_WP/MyTribe.arktribe")).toBe(true);
  });

  it("drops ARK's dated rolling backups (.ark + .arkrbf)", () => {
    expect(includeInBackup("SavedArks/TheIsland_WP/TheIsland_WP_18.06.2026_03.15.06.ark")).toBe(false);
    expect(includeInBackup("SavedArks/TheIsland_WP/TheIsland_WP_21.06.2026_02.49.58.arkrbf")).toBe(false);
  });

  it("drops the anti-corruption .bak and Logs/Cache dirs", () => {
    expect(includeInBackup("SavedArks/TheIsland_WP/TheIsland_WP_AntiCorruptionBackup.bak")).toBe(false);
    expect(includeInBackup("Logs/ShooterGame.log")).toBe(false);
    expect(includeInBackup("Cache/anything/at/all")).toBe(false);
  });
});

// ── create(): retention runs before the BackupCreated announcement (GH #65) ──────
import { mkdtemp, mkdir, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType } from "@ark/shared";

describe("BackupsService.create", () => {
  it("prunes past-retention snapshots BEFORE emitting BackupCreated, so replication never tars a dir mid-delete", async () => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
    const root = await mkdtemp(join(tmpdir(), "palisade-backups-"));
    process.env.DATA_DIR = root;
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
    try {
      await mkdir(join(root, "instances", "srv1", "world"), { recursive: true });
      await writeFile(join(root, "instances", "srv1", "world", "level.dat"), "live world");
      // One automatic snapshot already on disk + in the DB; keep=1 means it goes
      // as soon as the next one lands.
      const oldPath = join(root, "backups", "srv1", "scheduled-2026-09-07T07-45-00-123Z");
      await mkdir(oldPath, { recursive: true });
      await writeFile(join(oldPath, "level.dat"), "old world");
      const rows: { id: string; serverId: string; path: string; reason: string; createdAt: Date }[] = [
        { id: "old", serverId: "srv1", path: oldPath, reason: "scheduled", createdAt: new Date("2026-09-07T07:45:00Z") },
      ];
      const prisma = {
        server: { findUnique: async () => ({ id: "srv1", game: "MINECRAFT", backupKeep: 1 }) },
        snapshot: {
          create: async ({ data }: { data: { serverId: string; path: string; reason: string } }) => {
            const row = { id: "new", createdAt: new Date(), ...data };
            rows.push(row);
            return row;
          },
          findMany: async () => rows.slice(),
          delete: async ({ where }: { where: { id: string } }) => {
            const i = rows.findIndex((r) => r.id === where.id);
            if (i >= 0) rows.splice(i, 1);
            return {};
          },
        },
      };
      const seenAtEmit: { type: EventType; oldStillOnDisk: boolean }[] = [];
      const events = {
        emit: async (e: { type: EventType }) => {
          const oldStillOnDisk = await stat(oldPath).then(() => true, () => false);
          seenAtEmit.push({ type: e.type, oldStillOnDisk });
        },
      };
      const rcon = { saveWorld: async () => undefined };
      const { BackupsService } = await import("./backups.service");
      const svc = new BackupsService(prisma as never, events as never, rcon as never, {} as never);

      const snap = await svc.create("srv1", "scheduled");
      expect(snap.id).toBe("new");
      expect(seenAtEmit).toEqual([{ type: EventType.BackupCreated, oldStillOnDisk: false }]);
      expect(rows.map((r) => r.id)).toEqual(["new"]);
      await expect(stat(join(snap.path, "world", "level.dat"))).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
      resetEnvCache();
    }
  });

  it("refuses a backup that would capture nothing, leaving no row or directory behind", async () => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
    const root = await mkdtemp(join(tmpdir(), "palisade-backups-"));
    process.env.DATA_DIR = root;
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
    try {
      const prisma = {
        server: { findUnique: async () => ({ id: "srv1", game: "MINECRAFT", backupKeep: 1 }) },
        snapshot: { create: vi.fn() },
      };
      const events = { emit: vi.fn(async () => undefined) };
      const { BackupsService } = await import("./backups.service");
      const svc = new BackupsService(
        prisma as never,
        events as never,
        { saveWorld: async () => undefined } as never,
        {} as never,
      );

      await expect(svc.create("srv1", "manual")).rejects.toThrow("Nothing to back up yet");
      expect(prisma.snapshot.create).not.toHaveBeenCalled();
      expect(await readdir(join(root, "backups", "srv1"))).toEqual([]);
      expect(events.emit).toHaveBeenCalledWith(expect.objectContaining({ type: EventType.Warning }));
    } finally {
      await rm(root, { recursive: true, force: true });
      resetEnvCache();
    }
  });
});
