import { Injectable, Logger } from "@nestjs/common";
import { stat, mkdir, rm, rename, cp } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Game, EventType, STEAM_APP_ID } from "@ark/shared";
import { DockerService } from "../docker/docker.service";
import { EventsService } from "../events/events.service";
import { PrismaService } from "../prisma/prisma.service";
import { IMAGES } from "../common/images";
import { LocalPaths } from "../common/paths";
import { SNAPSHOT_FILE } from "../servers/server-snapshot";

const execFileP = promisify(execFile);

@Injectable()
export class InstallerService {
  private readonly logger = new Logger(InstallerService.name);
  /** Games currently having their golden cache seeded (process-local guard). */
  private readonly seeding = new Set<Game>();

  constructor(
    private readonly docker: DockerService,
    private readonly events: EventsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * "Install" a game = pull its server image. Both images (POK for ASA, hermsi
   * for ASE) download the game files + mods themselves on the first server boot,
   * so there's no separate SteamCMD step. Returns the Job id; `serverId` scopes
   * progress events to a server in the UI.
   */
  async install(game: Game, opts: { serverId?: string } = {}): Promise<string> {
    const job = await this.prisma.job.create({
      data: { type: "install", state: "running", serverId: opts.serverId ?? null },
    });

    await this.events.emit({
      type: EventType.InstallStarted,
      message: `Pulling the ${game} server image — game files install on first start`,
      serverId: opts.serverId,
      data: { jobId: job.id },
    });

    // Run detached from the request lifecycle; progress flows over realtime.
    void this.runImagePull(game, job.id, opts).catch((err) => {
      this.logger.error(`Install job ${job.id} failed: ${(err as Error).message}`);
    });

    return job.id;
  }

  /** Pull the server image; the game files install on the first server start. */
  private async runImagePull(
    game: Game,
    jobId: string,
    opts: { serverId?: string },
  ): Promise<void> {
    try {
      await this.docker.pullImage(IMAGES[game]);
      await this.prisma.job.update({
        where: { id: jobId },
        data: {
          state: "success",
          progress: 100,
          log: `${game} image ready. Game files install on the first server start.`,
        },
      });
      await this.events.emit({
        type: EventType.InstallFinished,
        message: `${game} image ready — game files install on first server start`,
        serverId: opts.serverId,
        data: { jobId },
      });
    } catch (err) {
      await this.prisma.job.update({
        where: { id: jobId },
        data: { state: "failed", error: (err as Error).message },
      });
      await this.events.emit({
        type: EventType.Error,
        message: `${game} image pull failed: ${(err as Error).message}`,
        serverId: opts.serverId,
        data: { jobId },
      });
    }
  }

  // ── ASA game-file caching (reflink) ─────────────────────────────────────────
  // POK installs ~13 GB into each server's own volume on first boot. To avoid a
  // fresh download per server, the first server seeds a golden copy and every
  // later server reflink-clones it (instant + ~0 disk on btrfs/XFS, falling back
  // to a deep copy elsewhere). See PLANNING.md → game-file caching.

  /** True once an instance holds the game files (POK's Steam manifest is present). */
  private async hasInstall(serverId: string, game: Game): Promise<boolean> {
    return this.exists(join(LocalPaths.instanceRoot(serverId), `appmanifest_${STEAM_APP_ID[game]}.acf`));
  }

  /** True once the golden cache for a game holds a complete install. */
  private async cacheReady(game: Game): Promise<boolean> {
    return this.exists(join(LocalPaths.gameCache(game), `appmanifest_${STEAM_APP_ID[game]}.acf`));
  }

  private async exists(p: string): Promise<boolean> {
    return stat(p).then(() => true).catch(() => false);
  }

  /**
   * Before an ASA start: if this instance has no game files yet but a warmed
   * golden cache exists, clone the cache into the instance so POK boots straight
   * to launch instead of re-downloading ~13 GB. No-op when the instance is
   * already installed, or no cache exists yet (the first server seeds it).
   */
  async prepareGameFiles(serverId: string, game: Game): Promise<void> {
    if (game !== Game.ASA) return; // ASE uses a shared install dir already
    if (await this.hasInstall(serverId, game)) return;
    if (!(await this.cacheReady(game))) return; // first server: POK downloads + seeds
    const dst = LocalPaths.instanceRoot(serverId);
    await mkdir(dst, { recursive: true });
    await this.cloneTree(LocalPaths.gameCache(game), dst);
    await this.events.emit({
      type: EventType.InstallFinished,
      message: "Game files restored from cache — skipped the ~13 GB download",
      serverId,
    });
  }

  /**
   * After the FIRST ASA server finishes installing, snapshot its game files into
   * the golden cache (minus the per-server world/config and POK's runtime state)
   * so every later server clones them instantly. Guarded to run once per game
   * while the cache is empty; safe to call on every "server ready".
   */
  async seedGameFilesCache(serverId: string, game: Game): Promise<void> {
    if (game !== Game.ASA) return;
    if (this.seeding.has(game)) return;
    if (await this.cacheReady(game)) return;
    if (!(await this.hasInstall(serverId, game))) return;

    this.seeding.add(game);
    const cache = LocalPaths.gameCache(game);
    const staging = `${cache}.seeding`;
    try {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      await this.cloneTree(LocalPaths.instanceRoot(serverId), staging);
      // Drop per-server world/config + POK coordination state → clean base install.
      for (const sub of ["ShooterGame/Saved", "instance_flags", "update_coordination", "steamapps/temp", SNAPSHOT_FILE]) {
        await rm(join(staging, sub), { recursive: true, force: true }).catch(() => undefined);
      }
      await rm(cache, { recursive: true, force: true }).catch(() => undefined);
      await rename(staging, cache); // atomic: cache appears complete or not at all
      this.logger.log(`Seeded ${game} game-file cache from server ${serverId}`);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      this.logger.warn(`${game} cache seed failed: ${(err as Error).message}`);
    } finally {
      this.seeding.delete(game);
    }
  }

  /**
   * Copy a directory tree, preferring btrfs/XFS reflinks (instant, copy-on-write)
   * and falling back to a deep copy. `-a` preserves owner/perms so POK (uid 7777)
   * keeps access. Reflink needs src+dst on one filesystem; `--reflink=auto`
   * silently degrades to a full copy otherwise, so this only throws when `cp`
   * lacks the flag (e.g. BSD cp in dev) — then we deep-copy via Node.
   */
  private async cloneTree(src: string, dst: string): Promise<void> {
    try {
      await execFileP("cp", ["-a", "--reflink=auto", `${src}/.`, dst]);
    } catch (err) {
      this.logger.warn(`reflink cp unavailable (${(err as Error).message}); deep-copying`);
      await cp(src, dst, { recursive: true, preserveTimestamps: true });
    }
  }

}
