import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import { Client, type SFTPWrapper } from "ssh2";
import { EventType } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { loadEnv } from "../config/env";
import { artifactsToPrune } from "../backups/retention";
import { DEFAULT_BACKUP_KEEP } from "../manager-settings/manager-settings.service";

/** Off-box replication config — stored as one encrypted setting. */
export interface ReplicationConfig {
  enabled: boolean;
  kind: "sftp" | "local";
  /** Destination base directory (remote path for sftp, in-container path for local). */
  dir: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
}

/** Non-secret status surfaced to the UI. */
export interface ReplicationStatus {
  lastSyncAt: string | null;
  lastError: string | null;
  lastUploaded: number;
}

const SYNC_INTERVAL_MS = 60 * 60_000; // hourly reconcile catches anything missed
const CONNECT_TIMEOUT_MS = 10_000;
/** Manager-DB snapshots mirrored (matches dbbackup's local KEEP). */
const MANAGER_KEEP = 14;

/**
 * Mirrors every backup off the box: each world snapshot uploads as a single
 * .tar.gz artifact and the manager-DB snapshots copy as-is, to an SFTP server
 * or another mounted path. A reconcile-style sync (after each BackupCreated
 * event, hourly, and on demand) uploads whatever the destination is missing,
 * so an unreachable target self-heals on the next pass. Remote retention
 * mirrors the local keep-N. Failures emit Warning events (→ notifications).
 */
@Injectable()
export class ReplicationService implements OnModuleInit {
  private readonly logger = new Logger(ReplicationService.name);
  private syncing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly settings: ManagerSettingsService,
  ) {}

  onModuleInit(): void {
    this.events.onEvent((input) => {
      if (input.type === EventType.BackupCreated) void this.sync().catch(() => undefined);
    });
    setInterval(() => void this.sync().catch(() => undefined), SYNC_INTERVAL_MS).unref?.();
  }

  // ── Config + status ─────────────────────────────────────────────────────────
  async getConfig(): Promise<ReplicationConfig | null> {
    const raw = await this.settings.get(SettingKeys.BackupReplication);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReplicationConfig;
    } catch {
      return null;
    }
  }

  async saveConfig(config: ReplicationConfig): Promise<void> {
    await this.settings.set(SettingKeys.BackupReplication, JSON.stringify(config));
  }

  async getStatus(): Promise<ReplicationStatus> {
    const raw = await this.settings.get(SettingKeys.BackupReplicationStatus);
    if (raw) {
      try {
        return JSON.parse(raw) as ReplicationStatus;
      } catch {
        /* fall through */
      }
    }
    return { lastSyncAt: null, lastError: null, lastUploaded: 0 };
  }

  private async setStatus(status: ReplicationStatus): Promise<void> {
    await this.settings.set(SettingKeys.BackupReplicationStatus, JSON.stringify(status));
  }

  /** Verify the destination is reachable and writable (probe file round-trip). */
  async test(): Promise<{ ok: boolean; message: string }> {
    const config = await this.getConfig();
    if (!config) return { ok: false, message: "Replication is not configured yet — save settings first." };
    try {
      const dest = await this.open(config);
      try {
        const probe = this.remoteJoin(config, ".palisade-probe");
        await dest.write(probe, Buffer.from(`palisade probe ${new Date().toISOString()}`));
        await dest.remove(probe);
        return { ok: true, message: `Connected — ${config.dir} is writable.` };
      } finally {
        await dest.close();
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  // ── Sync ────────────────────────────────────────────────────────────────────
  /** Upload every artifact the destination is missing; prune beyond retention. */
  async sync(): Promise<{ uploaded: number; skipped: boolean }> {
    const config = await this.getConfig();
    if (!config?.enabled || !config.dir) return { uploaded: 0, skipped: true };
    if (this.syncing) return { uploaded: 0, skipped: true };
    this.syncing = true;
    try {
      const dest = await this.open(config);
      let uploaded = 0;
      try {
        uploaded += await this.syncSnapshots(config, dest);
        uploaded += await this.syncManagerDb(config, dest);
      } finally {
        await dest.close();
      }
      await this.setStatus({ lastSyncAt: new Date().toISOString(), lastError: null, lastUploaded: uploaded });
      if (uploaded > 0) this.logger.log(`Replicated ${uploaded} backup artifact(s) to ${config.kind}:${config.dir}`);
      return { uploaded, skipped: false };
    } catch (err) {
      const message = (err as Error).message;
      await this.setStatus({
        lastSyncAt: (await this.getStatus()).lastSyncAt,
        lastError: message,
        lastUploaded: 0,
      });
      await this.events.emit({
        type: EventType.Warning,
        message: `Backup replication failed: ${message}`,
      });
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  private async syncSnapshots(config: ReplicationConfig, dest: Destination): Promise<number> {
    const snapshots = await this.prisma.snapshot.findMany({ include: { server: true } });
    const byServer = new Map<string, typeof snapshots>();
    for (const s of snapshots) {
      if (!byServer.has(s.serverId)) byServer.set(s.serverId, []);
      byServer.get(s.serverId)!.push(s);
    }

    let uploaded = 0;
    for (const [serverId, snaps] of byServer) {
      const dir = this.remoteJoin(config, serverId);
      await dest.mkdirp(dir);
      // A manifest makes the opaque serverId dirs navigable in a DR scenario.
      const server = snaps[0]!.server;
      await dest
        .write(
          this.remoteJoin(config, serverId, "manifest.json"),
          Buffer.from(JSON.stringify({ serverId, name: server.name, game: server.game }, null, 2)),
        )
        .catch(() => undefined);

      const existing = new Set(await dest.list(dir));
      for (const snap of snaps) {
        const artifact = `${posix.basename(snap.path.replaceAll("\\", "/"))}.tar.gz`;
        if (existing.has(artifact)) continue;
        if (!(await this.exists(snap.path))) continue; // pruned locally before ever syncing
        await this.uploadTarGz(snap.path, dest, this.remoteJoin(config, serverId, artifact));
        uploaded++;
      }
      // Remote retention mirrors local keep-N (manifest excluded from the count) —
      // including the manual exemption, or the copies we just protected locally
      // would still be deleted off the target (GH #34). Ordering is by the artifact's
      // timestamp, not its name: names start with the reason, so a plain sort would
      // delete every "auto-stop-*" before any older "scheduled-*".
      // Retention is the SERVER's own (GH #34 follow-up) — mirroring a single global
      // number would prune a target back to the wrong depth for every server.
      const keep = server.backupKeep ?? DEFAULT_BACKUP_KEEP;
      const artifacts = (await dest.list(dir)).filter((f) => f.endsWith(".tar.gz"));
      for (const stale of artifactsToPrune(artifacts, keep)) {
        await dest.remove(this.remoteJoin(config, serverId, stale)).catch(() => undefined);
      }
    }
    return uploaded;
  }

  private async syncManagerDb(config: ReplicationConfig, dest: Destination): Promise<number> {
    const localDir = join(loadEnv().DATA_DIR, "backups", "_manager");
    const files = (await readdir(localDir).catch(() => [] as string[]))
      .filter((f) => /^db-.*\.sqlite$/.test(f))
      .sort();
    if (files.length === 0) return 0;
    const dir = this.remoteJoin(config, "_manager");
    await dest.mkdirp(dir);
    const existing = new Set(await dest.list(dir));
    let uploaded = 0;
    for (const f of files) {
      if (existing.has(f)) continue;
      await dest.upload(join(localDir, f), this.remoteJoin(config, "_manager", f));
      uploaded++;
    }
    const remote = (await dest.list(dir)).filter((f) => /^db-.*\.sqlite$/.test(f)).sort();
    for (const stale of remote.slice(0, Math.max(0, remote.length - MANAGER_KEEP))) {
      await dest.remove(this.remoteJoin(config, "_manager", stale)).catch(() => undefined);
    }
    return uploaded;
  }

  /** Stream `tar czf - -C <dir> .` straight into the destination — no temp file. */
  private async uploadTarGz(localDir: string, dest: Destination, remotePath: string): Promise<void> {
    const tar = spawn("tar", ["czf", "-", "-C", localDir, "."]);
    // Attach BEFORE any awaiting: tar can exit while the pipeline drains, and a
    // listener added after "close" fired would wait forever (hung the first
    // live sync exactly this way).
    const exited = new Promise<number>((resolve) => tar.on("close", resolve));
    const sink = await dest.createWriteStream(remotePath);
    try {
      await pipeline(tar.stdout, sink);
    } catch (err) {
      await dest.remove(remotePath).catch(() => undefined); // no half-written artifacts
      throw err;
    }
    const code = await exited;
    if (code !== 0) {
      await dest.remove(remotePath).catch(() => undefined);
      throw new Error(`tar exited ${code} for ${localDir}`);
    }
  }

  private remoteJoin(config: ReplicationConfig, ...parts: string[]): string {
    return posix.join(config.dir, ...parts);
  }

  private async exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  // ── Destinations ───────────────────────────────────────────────────────────
  private async open(config: ReplicationConfig): Promise<Destination> {
    if (config.kind === "local") return new LocalDestination();
    return SftpDestination.connect(config);
  }
}

/** Minimal file operations both destination kinds implement. */
interface Destination {
  mkdirp(dir: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  write(path: string, data: Buffer): Promise<void>;
  upload(localPath: string, remotePath: string): Promise<void>;
  createWriteStream(path: string): Promise<Writable>;
  remove(path: string): Promise<void>;
  close(): Promise<void>;
}

/** Another path visible inside the container (e.g. an Unraid share mapped in). */
class LocalDestination implements Destination {
  async mkdirp(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }
  async list(dir: string): Promise<string[]> {
    return readdir(dir).catch(() => []);
  }
  async write(path: string, data: Buffer): Promise<void> {
    await writeFile(path, data);
  }
  async upload(localPath: string, remotePath: string): Promise<void> {
    await cp(localPath, remotePath);
  }
  async createWriteStream(path: string): Promise<Writable> {
    return createWriteStream(path);
  }
  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
  async close(): Promise<void> {
    /* nothing to release */
  }
}

class SftpDestination implements Destination {
  private constructor(
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
  ) {}

  static connect(config: ReplicationConfig): Promise<SftpDestination> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      client
        .on("ready", () => {
          client.sftp((err, sftp) => {
            if (err) {
              client.end();
              reject(err);
            } else {
              resolve(new SftpDestination(client, sftp));
            }
          });
        })
        .on("error", reject)
        .connect({
          host: config.host,
          port: config.port || 22,
          username: config.username,
          password: config.password || undefined,
          privateKey: config.privateKey || undefined,
          readyTimeout: CONNECT_TIMEOUT_MS,
        });
    });
  }

  async mkdirp(dir: string): Promise<void> {
    // Walk down creating each level; "already exists" failures are fine.
    const parts = dir.split("/").filter(Boolean);
    let current = dir.startsWith("/") ? "/" : "";
    for (const p of parts) {
      current = current === "/" || current === "" ? `${current}${p}` : `${current}/${p}`;
      await new Promise<void>((resolve) => this.sftp.mkdir(current, () => resolve()));
    }
    // Verify the leaf exists so a permission problem surfaces as an error.
    await new Promise<void>((resolve, reject) =>
      this.sftp.stat(dir, (err) => (err ? reject(new Error(`cannot create ${dir}: ${err.message}`)) : resolve())),
    );
  }

  list(dir: string): Promise<string[]> {
    return new Promise((resolve) =>
      this.sftp.readdir(dir, (err, entries) => resolve(err ? [] : entries.map((e) => e.filename))),
    );
  }

  write(path: string, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) =>
      this.sftp.writeFile(path, data, (err) => (err ? reject(err) : resolve())),
    );
  }

  upload(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) =>
      this.sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve())),
    );
  }

  async createWriteStream(path: string): Promise<Writable> {
    return this.sftp.createWriteStream(path);
  }

  remove(path: string): Promise<void> {
    return new Promise((resolve, reject) =>
      this.sftp.unlink(path, (err) => (err ? reject(err) : resolve())),
    );
  }

  async close(): Promise<void> {
    this.client.end();
  }
}
