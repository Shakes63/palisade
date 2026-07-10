import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import * as cron from "node-cron";
import { loadEnv } from "../config/env";

const execFileP = promisify(execFile);

/** Newest N manager-DB snapshots kept (one per day → two weeks of history). */
const KEEP = 14;

/**
 * Self-backup of the manager's own SQLite DB (server definitions, schedules,
 * snapshot index, encrypted passwords). World saves are covered by per-server
 * backups, but if db.sqlite corrupts, every server DEFINITION is gone even though
 * the game files survive — this is the cheap insurance against that. Runs nightly
 * (04:00) plus once on boot; snapshots land in backups/_manager/.
 * Uses sqlite3's online `.backup` (safe on a live DB); falls back to copying the
 * DB + its WAL sidecars if the sqlite3 CLI is missing (same pattern as the Conan
 * world backup).
 */
@Injectable()
export class DbBackupService implements OnModuleInit {
  private readonly logger = new Logger(DbBackupService.name);

  onModuleInit(): void {
    cron.schedule("0 4 * * *", () => void this.run());
    void this.run(); // one on boot, so a fresh deploy always has a snapshot
  }

  private dbPath(): string {
    // DATABASE_URL is "file:<path>" (relative paths resolve against the API cwd).
    return loadEnv().DATABASE_URL.replace(/^file:/, "");
  }

  private destDir(): string {
    return join(loadEnv().DATA_DIR, "backups", "_manager");
  }

  async run(): Promise<void> {
    try {
      const db = this.dbPath();
      const dir = this.destDir();
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dest = join(dir, `db-${stamp}.sqlite`);
      let viaSqlite = true;
      try {
        await execFileP("sqlite3", ["-readonly", db, `.backup '${dest}'`]);
      } catch {
        // No sqlite3 CLI (or it failed) — copy the DB + WAL sidecars; WAL mode
        // keeps the main file valid and the sidecars bring it current.
        viaSqlite = false;
        await cp(db, dest);
        await cp(`${db}-wal`, `${dest}-wal`).catch(() => undefined);
        await cp(`${db}-shm`, `${dest}-shm`).catch(() => undefined);
      }
      // A corrupt snapshot is worse than none — it silently displaces a good one
      // in the rotation. Verify and discard it while yesterday's copy still exists.
      if (viaSqlite) {
        const { stdout } = await execFileP("sqlite3", ["-readonly", dest, "PRAGMA integrity_check;"]);
        if (stdout.trim() !== "ok") {
          await rm(dest, { force: true });
          throw new Error(`snapshot failed integrity_check: ${stdout.trim().slice(0, 200)}`);
        }
      }
      await this.prune(dir);
      this.logger.log(`Manager DB backed up to ${dest}${viaSqlite ? " (integrity ok)" : ""}`);
    } catch (err) {
      this.logger.warn(`Manager DB backup failed: ${(err as Error).message}`);
    }
  }

  /** Keep the newest KEEP snapshots (a snapshot = db-*.sqlite plus its sidecars). */
  private async prune(dir: string): Promise<void> {
    const entries = (await readdir(dir)).filter((f) => /^db-.*\.sqlite$/.test(f)).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - KEEP))) {
      await rm(join(dir, stale), { force: true });
      await rm(join(dir, `${stale}-wal`), { force: true }).catch(() => undefined);
      await rm(join(dir, `${stale}-shm`), { force: true }).catch(() => undefined);
    }
  }
}
