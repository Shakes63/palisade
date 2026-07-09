import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { basename, join, dirname, relative, sep } from "node:path";
import { ServerState, EventType, Game } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { RconService } from "../rcon/rcon.service";
import { ManagerSettingsService } from "../manager-settings/manager-settings.service";
import { LocalPaths } from "../common/paths";
import { SERVER_UID, SERVER_GID } from "../common/images";
import { loadEnv } from "../config/env";

const execFileP = promisify(execFile);

// Conan's Saved dir holds the live SQLite world DB (game_N.db) + Config; the image
// also keeps its OWN rolling backups (game_N_backup_M.db) and noisy Logs/Crashes.
// We back up only the live DBs + config, dropping the image's rolling dupes (our
// retention is the history) and logs — a snapshot shrinks from ~40 MB to ~1 MB.
const CONAN_SKIP_DIRS = new Set(["Logs", "Crashes", "Cache"]);
const CONAN_ROLLING_DB = /^game_\d+_backup_\d+\.db$/i;

// ARK keeps its OWN rolling dated backups (Map_DD.MM.YYYY_HH.MM.SS.{ark,arkrbf}),
// an anti-corruption .bak, and noisy Logs/Cache dirs. Our snapshot only needs the
// LIVE world + players + tribes + config — our retention is the rolling history and
// our cross-snapshot copies are the corruption safety net. Excluding the rest cuts a
// snapshot from ~1.3 GB to the live world (~tens of MB).
const ARK_DATED_SAVE = /_\d{2}\.\d{2}\.\d{4}_\d{2}\.\d{2}\.\d{2}\.[a-z0-9]+$/i;
const SKIP_TOP_DIRS = new Set(["Logs", "Cache"]);

/** Whether a path under Saved/ belongs in a backup. `rel` is relative to Saved.
 *  Keeps the live world, config, and player/tribe data; drops ARK's dated rolling
 *  dupes, its anti-corruption .bak, and Logs/Cache. */
export function includeInBackup(rel: string): boolean {
  if (!rel) return true; // the Saved root itself
  if (SKIP_TOP_DIRS.has(rel.split(sep)[0] ?? "")) return false;
  if (rel.endsWith(".bak")) return false;
  return !ARK_DATED_SAVE.test(rel);
}

/**
 * Save backups: on-demand + scheduler-driven pre-action snapshots, with
 * retention rotation and restore. A backup is a copy of the instance Saved dir.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly rcon: RconService,
    private readonly settings: ManagerSettingsService,
  ) {}

  list(serverId: string) {
    return this.prisma.snapshot.findMany({
      where: { serverId },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Save the world (best-effort) then snapshot each of the game's save subpaths.
   *  The snapshot mirrors the instance's relevant subpaths (e.g. Bedrock captures
   *  worlds/ + behavior_packs/ + resource_packs/), so restore can put each back. */
  async create(serverId: string, reason: string) {
    const env = loadEnv();
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    const game = server.game as Game;
    await this.rcon.saveWorld(serverId).catch(() => undefined); // no-op on Conan
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const root = LocalPaths.instanceRoot(serverId);
    const destDir = join(env.DATA_DIR, "backups", serverId);
    const dest = join(destDir, `${reason}-${stamp}`);
    await mkdir(dest, { recursive: true });
    try {
      for (const sub of LocalPaths.saveSubpaths(game)) {
        const src = join(root, sub);
        if (!(await this.exists(src))) continue; // e.g. no Nether folder on a vanilla world
        const to = join(dest, sub);
        await mkdir(dirname(to), { recursive: true });
        if (game === Game.CONAN) {
          await this.backupConanSaved(src, to);
        } else {
          await cp(src, to, { recursive: true, filter: (s) => includeInBackup(relative(src, s)) });
        }
      }
    } catch (err) {
      throw new BadRequestException(`Backup failed: ${(err as Error).message}`);
    }

    const snapshot = await this.prisma.snapshot.create({ data: { serverId, path: dest, reason } });
    await this.events.emit({
      type: EventType.BackupCreated,
      message: `Backup (${reason}) created`,
      serverId,
      data: { path: dest },
    });
    await this.applyRetention(serverId);
    return snapshot;
  }

  /** Stream a snapshot as a tar.gz for a browser download (spawned tar; the
   *  manager runs as root so it can read game-owned files). */
  async download(serverId: string, snapshotId: string): Promise<{ stream: Readable; filename: string }> {
    const snap = await this.prisma.snapshot.findUnique({ where: { id: snapshotId } });
    if (!snap || snap.serverId !== serverId) throw new NotFoundException("Backup not found");
    if (!(await this.exists(snap.path))) throw new NotFoundException("Backup files are missing on disk");
    const tar = spawn("tar", ["czf", "-", "-C", snap.path, "."]);
    tar.on("error", (e) => this.logger.warn(`Backup download tar failed: ${e.message}`));
    tar.stderr.on("data", (d: Buffer) => this.logger.warn(`tar: ${d.toString().trim()}`));
    return { stream: tar.stdout, filename: `${basename(snap.path)}.tar.gz` };
  }

  /**
   * Import a saves archive uploaded through the browser (the tar.gz format our
   * save/backup downloads produce — instance-relative subpaths like
   * `config/worlds_local/…`). Extracts to a temp dir first, then restores ONLY the
   * game's known save subpaths (so a crafted archive can't write outside them).
   * Server must be stopped; the current state is snapshotted first so it's
   * reversible.
   */
  async importSaves(serverId: string, filename: string, data: Buffer) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    if (![ServerState.Stopped, ServerState.Crashed].includes(server.state as ServerState)) {
      throw new BadRequestException("Stop the server before importing saves");
    }
    if (!/\.(tar\.gz|tgz)$/i.test(filename)) {
      throw new BadRequestException("Upload a .tar.gz saves archive (as produced by Download)");
    }
    const game = server.game as Game;
    const root = LocalPaths.instanceRoot(serverId);
    const tmp = join(loadEnv().DATA_DIR, `.saves-import-${serverId}-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    try {
      const archive = join(tmp, "upload.tar.gz");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(archive, data);
      const extractDir = join(tmp, "x");
      await mkdir(extractDir, { recursive: true });
      await execFileP("tar", ["xzf", archive, "-C", extractDir]);

      const subs = LocalPaths.saveSubpaths(game);
      const present: string[] = [];
      for (const sub of subs) if (await this.exists(join(extractDir, sub))) present.push(sub);
      if (present.length === 0) {
        throw new BadRequestException(
          `The archive has none of this game's save folders (expected ${subs.join(", ")}).`,
        );
      }

      // Reversible: snapshot the current saves before replacing them.
      await this.create(serverId, "pre-import").catch(() => undefined);
      const [uid, gid] = this.runtimeOwner(game);
      for (const sub of present) {
        const dest = join(root, sub);
        await rm(dest, { recursive: true, force: true });
        await mkdir(dirname(dest), { recursive: true });
        await cp(join(extractDir, sub), dest, { recursive: true });
        await execFileP("chown", ["-R", `${uid}:${gid}`, dest]).catch(() => undefined);
      }
      await this.events.emit({
        type: EventType.BackupCreated,
        message: `Imported saves from upload (${present.join(", ")})`,
        serverId,
      });
      return { imported: present };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Restore a backup over the instance Saved dir. Server must be stopped. */
  async restore(serverId: string, snapshotId: string) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    if (![ServerState.Stopped, ServerState.Crashed].includes(server.state as ServerState)) {
      throw new BadRequestException("Stop the server before restoring a backup");
    }
    const snap = await this.prisma.snapshot.findUnique({ where: { id: snapshotId } });
    if (!snap) throw new NotFoundException("Backup not found");

    const game = server.game as Game;
    const root = LocalPaths.instanceRoot(serverId);
    const [uid, gid] = this.runtimeOwner(game);
    // Snapshot the current state first so a restore is itself reversible.
    await this.create(serverId, "pre-restore").catch(() => undefined);
    // Replace each captured save subpath wholesale (removing Conan's live .db-wal/
    // .db-shm too, so the restored DB isn't shadowed by a stale WAL), then chown to
    // the runtime user so the server can read/write the restored files on next start.
    for (const sub of LocalPaths.saveSubpaths(game)) {
      const from = join(snap.path, sub);
      if (!(await this.exists(from))) continue; // this subpath wasn't in the snapshot
      const dest = join(root, sub);
      await rm(dest, { recursive: true, force: true });
      await mkdir(dirname(dest), { recursive: true });
      await cp(from, dest, { recursive: true });
      await execFileP("chown", ["-R", `${uid}:${gid}`, dest]).catch(() => undefined);
    }
    await this.events.emit({
      type: EventType.BackupCreated,
      message: `Restored backup from ${snap.createdAt.toISOString()}`,
      serverId,
    });
    return { restored: true };
  }

  /**
   * Back up Conan's Saved dir: a consistent online copy of each live SQLite world
   * DB (game_N.db) plus the small static files (Config/, serveruid.txt), skipping
   * the image's own rolling backups and logs. sqlite3's `.backup` snapshots a live
   * DB safely; if it's unavailable we fall back to copying the DB + its WAL sidecars
   * (WAL mode keeps the main file valid, and the WAL brings it current).
   */
  private async backupConanSaved(src: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const e of entries) {
      const name = e.name;
      if (CONAN_SKIP_DIRS.has(name)) continue; // Logs, Crashes, Cache
      if (CONAN_ROLLING_DB.test(name)) continue; // the image's own rolling backups
      if (/\.db-(wal|shm)$/.test(name)) continue; // copied alongside their .db (fallback only)
      const from = join(src, name);
      const to = join(dest, name);
      if (name.endsWith(".db")) {
        await this.backupSqliteDb(from, to);
      } else {
        await cp(from, to, { recursive: true }); // Config/, serveruid.txt, …
      }
    }
  }

  /** Consistent copy of one live SQLite DB (sqlite3 .backup), with a file-copy
   *  fallback (DB + WAL sidecars) if sqlite3 isn't present. */
  private async backupSqliteDb(from: string, to: string): Promise<void> {
    try {
      // -readonly: open the live DB for reading only (the game owns the file; the
      // manager just needs to read it), and .backup snapshots it consistently.
      await execFileP("sqlite3", ["-readonly", from, `.backup '${to}'`]);
    } catch (err) {
      this.logger.warn(
        `sqlite3 backup of ${from} failed (${(err as Error).message}); copying the DB + WAL instead`,
      );
      await cp(from, to);
      for (const ext of ["-wal", "-shm"]) {
        await cp(`${from}${ext}`, `${to}${ext}`).catch(() => undefined); // may not exist
      }
    }
  }

  async remove(snapshotId: string) {
    const snap = await this.prisma.snapshot.findUnique({ where: { id: snapshotId } });
    if (!snap) throw new NotFoundException("Backup not found");
    await rm(snap.path, { recursive: true, force: true }).catch(() => undefined);
    await this.prisma.snapshot.delete({ where: { id: snapshotId } });
    return { ok: true };
  }

  /** Keep the newest N backups per server (N from settings); delete the rest. */
  private async applyRetention(serverId: string): Promise<void> {
    const keep = await this.settings.getBackupKeep();
    const all = await this.prisma.snapshot.findMany({
      where: { serverId },
      orderBy: { createdAt: "desc" },
    });
    for (const old of all.slice(keep)) {
      await rm(old.path, { recursive: true, force: true }).catch(() => undefined);
      await this.prisma.snapshot.delete({ where: { id: old.id } }).catch(() => undefined);
    }
  }

  private async exists(p: string): Promise<boolean> {
    return stat(p)
      .then(() => true)
      .catch(() => false);
  }

  /** The uid/gid the game's server process runs as (so restored files stay readable
   *  + writable). The itzg images (Minecraft/Bedrock) and Icarus run as the manager's
   *  PUID/PGID; the others run as their image's fixed user (SERVER_UID/SERVER_GID). */
  private runtimeOwner(game: Game): [number, number] {
    if (
      game === Game.MINECRAFT ||
      game === Game.BEDROCK ||
      game === Game.ICARUS ||
      game === Game.SEVEN_DAYS ||
      game === Game.ENSHROUDED ||
      game === Game.SOTF ||
      game === Game.SATISFACTORY ||
      game === Game.LIF
    ) {
      const env = loadEnv();
      return [Number(env.PUID), Number(env.PGID)];
    }
    return [SERVER_UID[game], SERVER_GID[game]];
  }
}
