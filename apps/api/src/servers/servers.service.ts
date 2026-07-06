import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { mkdir, writeFile, rm, cp, chmod, chown } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, dirname, relative, sep } from "node:path";
import {
  Game,
  ServerState,
  LIVE_STATES,
  EventType,
  RealtimeTopic,
  DEFAULT_PORTS,
  RAM_ESTIMATE_MB,
  type RunningServerRam,
  type InsufficientRamInfo,
  type CreateServerDto,
  type UpdateServerDto,
  type ServerSummary,
  type ServerStats,
  type ServerStatsById,
  type ServerStatsDetail,
  type ServerConfigValues,
} from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { EventsService } from "../events/events.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { DockerService } from "../docker/docker.service";
import { CatalogService } from "../catalog/catalog.service";
import { InstallerService } from "../installer/installer.service";
import { RconService } from "../rcon/rcon.service";
import { StateMachineService } from "./state-machine.service";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { LogCaptureService, LOG_CAPTURE_MAX } from "../logs/log-capture.service";
import { buildContainerSpec } from "./runtime-spec";
import { portsFor } from "../catalog/ports";
import { LocalPaths } from "../common/paths";
import { containerName } from "../common/naming";
import { hostStats } from "../common/host-stats";
import { IMAGES, SERVER_UID, SERVER_GID } from "../common/images";
import { loadEnv } from "../config/env";

type ServerRow = Awaited<ReturnType<PrismaService["server"]["findUnique"]>> & {
  cluster?: { clusterId: string } | null;
};

// Readiness marker: when is the server actually joinable? POK/ASA pipes ARK's own
// log to stdout, which escalates through THREE markers as it finishes booting —
// `has successfully started!`, then `Full Startup: N seconds`, then finally
// `Server has completed startup and is now advertising for join`. Only the LAST
// means players can connect; the first two fire ~30s earlier (still finalizing
// world save / GC), so flipping on them shows "Running" before the server takes
// joins. We wait for `advertising for join`. The hermsi/ASE image instead prints
// arkmanager's `server is up` on stdout (ASE's own advertising line goes to a
// file inside the container, not docker logs), so keep that for ASE.
//
// The `(?!')` guard is essential: POK logs a line that QUOTES the marker —
//   Waiting for startup completion markers: 'Full Startup:' or 'Server has
//   completed startup and is now advertising for join'
// — while still booting. The real completion line isn't quoted (it ends with
// `. (NN.NGB Mem)`), so rejecting a trailing single-quote after "join" tells the
// two apart, whether we test one line or a multi-line blob.
//
// Conan (acekorneya/conan_enhanced_server): the game logs a one-shot
// `LogServerStats: Startup report. StartupTime=N ... Region=...` exactly when
// startup completes — after the ~30s world load that follows "Rcon is ready" and
// engine init, right as SourceServerQueries opens the query port. That's the true
// joinable moment (verified against a real Conan boot); the earlier RCON/engine-init
// lines fire ~30s too soon. The `StartupTime=` format is Conan-specific, so it
// won't misfire on ARK.
//
// Palworld (thijsvanloef): logs `Running Palworld dedicated server on :<port>` once,
// when the server starts listening — its joinable marker (verified against a real boot).
//
// Minecraft (itzg): the server logs `Done (12.345s)! For help, type "help"` exactly
// once when the world has finished loading and it accepts joins (and RCON). The
// `Done (...s)!` shape is Minecraft-specific, so it won't misfire on the others.
//
// Icarus: has no RCON to lean on, so readiness is log-based. This clause requires
// the literal "Icarus" near a ready/listening word so it can't false-fire on the
// other games (whose logs never mention Icarus). PROVISIONAL — confirm the exact
// line against a real boot and tighten it (the server is stuck "Starting" if wrong).
export const READY_RE =
  /(advertising for join(?!')|server is up|Startup report\. StartupTime=|Running Palworld dedicated server|Done \([\d.]+s\)! For help|Icarus.{0,60}\b(?:ready|listening|up and running)\b)/i;
const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_LIMIT = 3;

@Injectable()
export class ServersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ServersService.name);
  private readonly logStops = new Map<string, () => void>();
  private readonly crashTimes = new Map<string, number[]>();
  /** Serializes lifecycle ops per server (no double-start / start-while-update). */
  private readonly locks = new Map<string, Promise<unknown>>();
  /**
   * Servers being deliberately stopped. The crash watchdog checks this so a
   * container exiting *because we asked it to* is never mistaken for a crash and
   * auto-restarted (belt-and-suspenders over the Stopping-state guard, which can
   * race the exit).
   */
  private readonly stopping = new Set<string>();
  /** On-disk instance size (MB), refreshed in the background — `du` is too slow to
   *  run inline on every stats poll. */
  private readonly diskCache = new Map<string, { mb: number; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventsService,
    private readonly realtime: RealtimeGateway,
    private readonly docker: DockerService,
    private readonly catalog: CatalogService,
    private readonly installer: InstallerService,
    private readonly rcon: RconService,
    private readonly sm: StateMachineService,
    private readonly settings: ManagerSettingsService,
    private readonly logCapture: LogCaptureService,
  ) {}

  /** The captured log / console for the current run (survives refresh + tab
   *  switches; wiped on Start). */
  runLog(id: string): string {
    return this.logCapture.getLogs(id);
  }
  runConsole(id: string): string {
    return this.logCapture.getConsole(id);
  }

  // ── Startup reconciliation ──────────────────────────────────────────────────
  /** On boot, re-sync DB state + monitors with the Docker reality (see reconcile). */
  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile().catch((e) =>
      this.logger.error(`Startup reconcile failed: ${(e as Error).message}`),
    );
  }

  /**
   * Reconcile persisted state with running containers after a manager restart.
   * Game containers keep running while the manager is down (RestartPolicy=no, but
   * we never stopped them) — yet the log-follow monitors, crash watchers and RCON
   * connections live only in memory. So: re-adopt every running container
   * (re-attaching its monitors) and mark vanished ones Stopped/Crashed.
   */
  async reconcile(): Promise<void> {
    const [servers, containers] = await Promise.all([
      this.prisma.server.findMany(),
      this.docker.listManagedServers().catch((e) => {
        this.logger.warn(`reconcile: cannot list containers: ${(e as Error).message}`);
        return [] as Awaited<ReturnType<DockerService["listManagedServers"]>>;
      }),
    ]);
    const byServer = new Map(containers.filter((c) => c.serverId).map((c) => [c.serverId, c]));

    let adopted = 0;
    let reset = 0;
    let resumed = 0;
    for (const server of servers) {
      const c = byServer.get(server.id);
      const dbState = server.state as ServerState;
      if (c?.running) {
        if (dbState === ServerState.Stopping) {
          // We died mid-stop (typically a manager update). Finish the stop the
          // user asked for, rather than re-adopting the container as Running and
          // silently undoing it.
          this.logger.log(`reconcile: resuming interrupted stop for ${server.id}`);
          void this.tearDownStopped(server.id, c.id);
          resumed++;
          continue;
        }
        await this.adoptRunning(server.id, c.id, dbState);
        adopted++;
      } else {
        // Exited or gone: drop the stale container + link, then settle the DB.
        if (c) await this.docker.remove(c.id).catch(() => undefined);
        if (server.containerId) {
          await this.prisma.server
            .update({ where: { id: server.id }, data: { containerId: null } })
            .catch(() => undefined);
        }
        if (dbState !== ServerState.Stopped && dbState !== ServerState.Crashed) {
          // A Stopping server whose container is now gone IS the stop we wanted —
          // resolve to Stopped even if we died before finishing cleanup. Only an
          // unexpected exit (was Running/Starting) counts as a Crash.
          const stopped = dbState === ServerState.Stopping || !c;
          await this.sm.force(
            server.id,
            stopped ? ServerState.Stopped : ServerState.Crashed,
            dbState === ServerState.Stopping
              ? "stop completed (container exited)"
              : c
                ? "container exited while manager was down"
                : "no container on restart",
          );
          reset++;
        }
      }
    }
    if (adopted || reset || resumed) {
      this.logger.log(
        `Reconcile: adopted ${adopted} running, reset ${reset} stale, resumed ${resumed} stop`,
      );
    }
  }

  /** Re-link a still-running container and re-attach its readiness/crash monitors. */
  private async adoptRunning(
    serverId: string,
    containerId: string,
    dbState: ServerState,
  ): Promise<void> {
    await this.prisma.server
      .update({ where: { id: serverId }, data: { containerId } })
      .catch(() => undefined);
    // It's alive → it should be Running, unless its logs show it's still booting.
    let target = ServerState.Running;
    if (dbState === ServerState.Starting) {
      const log = await this.docker.tailLogs(containerId, 5000).catch(() => "");
      target = READY_RE.test(log) ? ServerState.Running : ServerState.Starting;
    }
    if (target !== dbState) {
      await this.sm.force(serverId, target, "adopted running container on restart");
    }
    await this.attachMonitors(serverId, containerId);
  }

  // ── Locking ────────────────────────────────────────────────────────────────
  private async withLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(serverId)) await this.locks.get(serverId);
    const p = fn().finally(() => this.locks.delete(serverId));
    this.locks.set(serverId, p);
    return p;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────--
  async list(): Promise<ServerSummary[]> {
    const rows = await this.prisma.server.findMany({ include: { cluster: true } });
    // One image-presence check per distinct game (image is shared per game).
    const games = [...new Set(rows.map((r) => r.game as Game))];
    const ready = new Map<Game, boolean>();
    await Promise.all(games.map(async (g) => ready.set(g, await this.docker.imageExists(IMAGES[g]))));
    return rows.map((r) => this.toSummary(r, ready.get(r.game as Game) ?? false));
  }

  async get(id: string): Promise<ServerSummary> {
    const row = await this.prisma.server.findUnique({ where: { id }, include: { cluster: true } });
    if (!row) throw new NotFoundException("Server not found");
    const imageReady = await this.docker.imageExists(IMAGES[row.game as Game]);
    return this.toSummary(row, imageReady);
  }

  /** The last N lines of the server's container log (empty when not running). */
  async tailLog(id: string, tail = 200): Promise<string> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("Server not found");
    if (!server.containerId) return "";
    return this.docker.tailLogs(server.containerId, tail).catch(() => "");
  }

  /** Live resource usage: CPU% + memory from Docker, plus the on-disk instance
   *  size (cached + background-refreshed). */
  async stats(id: string): Promise<ServerStatsDetail> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("Server not found");
    const [serverStats, host] = await Promise.all([
      this.statsFor(server.id, server.containerId),
      hostStats(loadEnv().DATA_DIR),
    ]);
    return { ...serverStats, host };
  }

  /** Stats for every server, keyed by id (for the servers list). */
  async statsAll(): Promise<ServerStatsById[]> {
    const servers = await this.prisma.server.findMany({ select: { id: true, containerId: true } });
    return Promise.all(
      servers.map(async (s) => ({ id: s.id, ...(await this.statsFor(s.id, s.containerId)) })),
    );
  }

  /** Build a stats payload. We query Docker whenever a container is linked — that
   *  covers Starting (boot is the heaviest period), not just Running — and Docker
   *  returns null when the container isn't actually up. */
  private async statsFor(serverId: string, containerId: string | null): Promise<ServerStats> {
    const live = containerId ? await this.docker.stats(containerId) : null;
    return {
      live: !!live,
      cpuPercent: live?.cpuPercent ?? null,
      memUsedMb: live?.memUsedMb ?? null,
      memLimitMb: live?.memLimitMb ?? null,
      diskUsedMb: this.diskUsedMb(serverId),
    };
  }

  /** Last-known on-disk instance size (MB), kicking a background refresh when
   *  stale. Null until the first measurement lands — `du` is too slow to await on
   *  every poll. */
  private diskUsedMb(serverId: string): number | null {
    const cached = this.diskCache.get(serverId);
    if (!cached || Date.now() - cached.at > 120_000) {
      void this.computeDiskMb(serverId).then((mb) => {
        if (mb !== null) this.diskCache.set(serverId, { mb, at: Date.now() });
      });
    }
    return cached?.mb ?? null;
  }

  private computeDiskMb(serverId: string): Promise<number | null> {
    return new Promise((resolve) => {
      execFile(
        "du",
        ["-sm", LocalPaths.instanceRoot(serverId)],
        { timeout: 15_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const mb = parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
          resolve(Number.isFinite(mb) ? mb : null);
        },
      );
    });
  }

  async getConfig(id: string): Promise<ServerConfigValues> {
    const row = await this.prisma.server.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Server not found");
    return JSON.parse(row.configJson) as ServerConfigValues;
  }

  async create(dto: CreateServerDto): Promise<ServerSummary> {
    if (!Object.values(Game).includes(dto.game)) throw new BadRequestException("Invalid game");
    // Every server of a given family shares one fixed port block so a single set of
    // port-forwards covers whichever is running — only one runs at a time, so the
    // shared ports never actually collide. Minecraft uses its own TCP block (25565).
    const ports = portsFor(dto.game);

    const defaults = this.catalog.defaultsFor(dto.game);
    const config: ServerConfigValues = {
      ...defaults,
      ...(dto.config ?? {}),
      values: { ...defaults.values, ...(dto.config?.values ?? {}) },
    };

    const server = await this.prisma.$transaction(async (tx) => {
      const created = await tx.server.create({
        data: {
          name: dto.name,
          game: dto.game,
          map: dto.map,
          maxPlayers: dto.maxPlayers ?? 70,
          clusterId: dto.clusterId ?? null,
          gamePort: ports.game,
          rawSocketPort: ports.rawSocket,
          queryPort: ports.query,
          rconPort: ports.rcon,
          adminPasswordEnc: this.crypto.encryptOptional(dto.adminPassword),
          serverPasswordEnc: this.crypto.encryptOptional(dto.serverPassword),
          spectatorPasswordEnc: this.crypto.encryptOptional(dto.spectatorPassword),
          configJson: JSON.stringify(config),
          modIds: JSON.stringify(dto.modIds ?? []),
          ramLimitMb: dto.ramLimitMb ?? null,
          cpuLimit: dto.cpuLimit ?? null,
        },
        include: { cluster: true },
      });
      return created;
    });

    await this.events.emit({
      type: EventType.ServerCreated,
      message: `Created server "${server.name}" (${server.game}, ${server.map})`,
      serverId: server.id,
    });
    return this.toSummary(server);
  }

  /** Adopt an existing server: create the record, then copy in an existing
   *  Saved directory (host path reachable by the manager) if provided. */
  async importExisting(
    dto: CreateServerDto,
    savedSourcePath?: string,
  ): Promise<ServerSummary> {
    const summary = await this.create(dto);
    if (savedSourcePath) {
      const dest = LocalPaths.savedDir(summary.id, summary.game); // game-aware Saved dir
      await mkdir(dirname(dest), { recursive: true });
      await cp(savedSourcePath, dest, { recursive: true }).catch((err) => {
        throw new BadRequestException(`Import copy failed: ${(err as Error).message}`);
      });
      await this.events.emit({
        type: EventType.ServerCreated,
        message: `Imported existing saves from ${savedSourcePath}`,
        serverId: summary.id,
      });
    }
    return summary;
  }

  async update(id: string, dto: UpdateServerDto): Promise<ServerSummary> {
    const existing = await this.prisma.server.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Server not found");

    const data: Record<string, unknown> = {};
    // Almost everything here is baked into the launch command / generated INI when
    // the container is created (SessionName from name, ServerPassword, max players,
    // -mods, settings, resource limits...). A running server therefore needs a
    // RESTART to pick the change up. Track that so we can flag configDirty and the
    // UI shows the Restart button — the same affordance settings/mod edits already
    // get. Diff against the current value so re-saving an unchanged field (e.g. the
    // settings form re-sending the name) doesn't spuriously prompt a restart.
    let launchChanged = false;
    if (dto.name !== undefined && dto.name !== existing.name) {
      data.name = dto.name;
      launchChanged = true;
    }
    if (dto.map !== undefined && dto.map !== existing.map) {
      data.map = dto.map;
      launchChanged = true;
    }
    if (dto.maxPlayers !== undefined && dto.maxPlayers !== existing.maxPlayers) {
      data.maxPlayers = dto.maxPlayers;
      launchChanged = true;
    }
    if (dto.clusterId !== undefined && dto.clusterId !== existing.clusterId) {
      data.clusterId = dto.clusterId;
      launchChanged = true;
    }
    if (dto.modIds !== undefined) {
      const next = JSON.stringify(dto.modIds);
      if (next !== existing.modIds) {
        data.modIds = next;
        launchChanged = true;
      }
    }
    if (dto.ramLimitMb !== undefined && dto.ramLimitMb !== existing.ramLimitMb) {
      data.ramLimitMb = dto.ramLimitMb;
      launchChanged = true;
    }
    if (dto.cpuLimit !== undefined && dto.cpuLimit !== existing.cpuLimit) {
      data.cpuLimit = dto.cpuLimit;
      launchChanged = true;
    }
    // Passwords: diff against the DECRYPTED current value — re-encrypting always
    // produces different ciphertext, so the stored blob can't be compared directly.
    const applyPassword = (enc: string | null, next: string | undefined, field: string) => {
      if (next === undefined || next === "") return; // blank/absent = leave as-is
      let current: string;
      try {
        current = enc ? this.crypto.decrypt(enc) : "";
      } catch {
        current = ""; // undecryptable → treat as a change
      }
      if (next !== current) {
        data[field] = this.crypto.encrypt(next);
        launchChanged = true;
      }
    };
    applyPassword(existing.adminPasswordEnc, dto.adminPassword, "adminPasswordEnc");
    applyPassword(existing.spectatorPasswordEnc, dto.spectatorPassword, "spectatorPasswordEnc");
    // Join password is shown in the UI and clearable: an explicit "" REMOVES it
    // (unlike the secrets above, where "" means "leave unchanged"). Absent = keep.
    if (dto.serverPassword !== undefined) {
      let current: string;
      try {
        current = existing.serverPasswordEnc ? this.crypto.decrypt(existing.serverPasswordEnc) : "";
      } catch {
        current = " "; // undecryptable → force a change
      }
      if (dto.serverPassword !== current) {
        data.serverPasswordEnc = dto.serverPassword ? this.crypto.encrypt(dto.serverPassword) : null;
        launchChanged = true;
      }
    }
    if (dto.config) {
      const merged: ServerConfigValues = {
        ...JSON.parse(existing.configJson),
        ...dto.config,
        values: {
          ...JSON.parse(existing.configJson).values,
          ...(dto.config.values ?? {}),
        },
      };
      data.configJson = JSON.stringify(merged);
      launchChanged = true; // settings feed the generated INI / command line
    }
    if (launchChanged) data.configDirty = true; // → UI shows the Restart button

    const updated = await this.prisma.server.update({
      where: { id },
      data,
      include: { cluster: true },
    });
    // Renamed a live server → rename its container too, so the Unraid dashboard
    // and bridge RCON host stay in sync without a restart. Best-effort: containers
    // are matched by the ark.serverId label, so a failure here is purely cosmetic.
    if (dto.name !== undefined && dto.name !== existing.name && existing.containerId) {
      await this.docker
        .rename(existing.containerId, containerName(id, existing.game as Game, dto.name))
        .catch((e) => this.logger.warn(`rename container for ${id} failed: ${(e as Error).message}`));
    }
    await this.events.emit({
      type: EventType.ConfigChanged,
      message: `Updated server "${updated.name}"`,
      serverId: id,
      data: { fields: Object.keys(data) },
    });
    return this.toSummary(updated);
  }

  /**
   * Copy this server's settings and/or mods onto other servers (REPLACE, not the
   * merge `update` does — the targets end up matching the source). Same-game only;
   * cross-game targets are skipped since the settings catalogs differ. Like a
   * normal config edit, copied settings take effect on the target's next start.
   */
  async copyTo(
    sourceId: string,
    opts: { targetIds: string[]; settings: boolean; mods: boolean },
  ): Promise<{ copied: number }> {
    if (!opts.settings && !opts.mods) throw new BadRequestException("Nothing selected to copy");
    const source = await this.prisma.server.findUnique({ where: { id: sourceId } });
    if (!source) throw new NotFoundException("Source server not found");

    const targets = await this.prisma.server.findMany({
      where: { id: { in: opts.targetIds ?? [] } },
    });
    const label = [opts.settings && "settings", opts.mods && "mods"].filter(Boolean).join(" + ");
    let copied = 0;
    for (const t of targets) {
      if (t.id === sourceId || t.game !== source.game) continue;
      const data: Record<string, unknown> = {};
      if (opts.settings) {
        data.configJson = source.configJson;
        data.configDirty = true; // copied settings apply on the target's next start
      }
      if (opts.mods) data.modIds = source.modIds;
      await this.prisma.server.update({ where: { id: t.id }, data });
      await this.events.emit({
        type: EventType.ConfigChanged,
        message: `Copied ${label} from "${source.name}" to "${t.name}"`,
        serverId: t.id,
      });
      copied++;
    }
    return { copied };
  }

  async remove(id: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("Server not found");
    await this.withLock(id, async () => {
      if (server.containerId) await this.docker.remove(server.containerId).catch(() => undefined);
      await this.docker.removeByServerId(id).catch(() => undefined);
      this.logStops.get(id)?.();
      this.logStops.delete(id);
      await this.prisma.portAllocation.deleteMany({ where: { serverId: id } });
      await this.prisma.server.delete({ where: { id } });
    });
    await this.events.emit({
      type: EventType.ServerDeleted,
      message: `Deleted server "${server.name}"`,
      serverId: id,
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────---
  async installGame(id: string): Promise<{ jobId: string }> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("Server not found");
    const jobId = await this.installer.install(server.game as Game, { serverId: id });
    return { jobId };
  }

  async start(id: string, opts: { force?: boolean; stopFirst?: string } = {}): Promise<void> {
    if (opts.stopFirst && opts.stopFirst !== id) {
      // Free the chosen server's RAM first, then start this one. stop() returns once
      // teardown begins but holds the server's lock until it completes — await that
      // so the RAM is actually reclaimed before we launch.
      await this.stop(opts.stopFirst).catch(() => undefined);
      await this.locks.get(opts.stopFirst)?.catch(() => undefined);
    } else if (!opts.force) {
      await this.assertRamAvailable(id);
    }
    return this.withLock(id, () => this.doStart(id));
  }

  /** Throw a 409 (with the running servers + RAM) if starting `id` would exceed the
   *  host's free RAM. A server's ramLimitMb overrides the per-game estimate. */
  private async assertRamAvailable(id: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("Server not found");
    const needMb = server.ramLimitMb ?? RAM_ESTIMATE_MB[server.game as Game];
    const host = await hostStats(loadEnv().DATA_DIR);
    const running = await this.runningServersRam();
    // Free RAM now, minus each running server's remaining headroom up to its peak
    // estimate — so a not-yet-peaked server (e.g. an empty one that fills up) can't
    // OOM the box after we start another. Headroom is 0 when we can't read its usage.
    const reservedMb = running.reduce((sum, r) => {
      const est = RAM_ESTIMATE_MB[r.game];
      return sum + Math.max(0, est - (r.ramUsedMb ?? est));
    }, 0);
    const availableMb = Math.max(0, host.memTotalMb - host.memUsedMb - reservedMb);
    if (needMb <= availableMb) return;
    throw new ConflictException({
      code: "INSUFFICIENT_RAM",
      needMb,
      availableMb,
      totalMb: host.memTotalMb,
      running,
    } satisfies InsufficientRamInfo);
  }

  /** Currently-running servers with their live RAM, for the start-guard dialog. */
  private async runningServersRam(): Promise<RunningServerRam[]> {
    const rows = await this.prisma.server.findMany({ where: { state: { in: LIVE_STATES } } });
    return Promise.all(
      rows.map(async (r) => {
        const st = r.containerId ? await this.docker.stats(r.containerId).catch(() => null) : null;
        return { id: r.id, name: r.name, game: r.game as Game, ramUsedMb: st?.memUsedMb ?? null };
      }),
    );
  }

  private async doStart(id: string): Promise<void> {
    const server = (await this.prisma.server.findUnique({
      where: { id },
      include: { cluster: true },
    })) as ServerRow;
    if (!server) throw new NotFoundException("Server not found");
    const state = server.state as ServerState;
    if (![ServerState.Stopped, ServerState.Crashed].includes(state)) {
      throw new BadRequestException(`Cannot start from state ${state}`);
    }

    await this.sm.transition(id, ServerState.Starting);
    try {
      const game = server.game as Game;
      // Clone game files from the warmed cache if available, so POK boots
      // straight to launch instead of re-downloading ~13 GB (no-op for ASE,
      // for the first server, or if this instance is already installed).
      await this.installer.prepareGameFiles(id, game);
      // Cluster members share one transfer dir (mounted into each); ensure it
      // exists and is writable by the server's runtime user before launch.
      if (server.cluster) {
        const clusterDir = LocalPaths.cluster(server.cluster.clusterId);
        await mkdir(clusterDir, { recursive: true });
        await this.makeServerWritable(game, clusterDir);
      }
      await this.writeInis(server);

      // Both images install their own mods on first boot (POK via MOD_IDS,
      // hermsi via `arkmanager installmod`), so nothing to pre-download here.
      const modIds = JSON.parse(server.modIds) as number[];

      const spec = buildContainerSpec({
        serverId: server.id,
        game: server.game as Game,
        map: server.map,
        sessionName: server.name,
        ports: this.portsOf(server),
        maxPlayers: server.maxPlayers,
        adminPassword: server.adminPasswordEnc
          ? this.crypto.decrypt(server.adminPasswordEnc)
          : "changeme",
        serverPassword: server.serverPasswordEnc
          ? this.crypto.decrypt(server.serverPasswordEnc)
          : null,
        spectatorPassword: server.spectatorPasswordEnc
          ? this.crypto.decrypt(server.spectatorPasswordEnc)
          : null,
        modIds,
        cluster: server.cluster ? { clusterId: server.cluster.clusterId } : null,
        config: JSON.parse(server.configJson) as ServerConfigValues,
        catalog: this.catalog.getCatalog(server.game as Game),
        ramLimitMb: server.ramLimitMb,
        cpuLimit: server.cpuLimit,
        timezone: await this.settings.getTimezone(),
        // Minecraft only: lets itzg auto-install a selected CurseForge modpack.
        curseForgeApiKey:
          (server.game as Game) === Game.MINECRAFT
            ? await this.settings.get(SettingKeys.CurseForgeApiKey)
            : null,
      });

      // Fresh run → wipe the captured log/console so it starts clean.
      this.logCapture.clear(id);
      // Remove any stale container with the same name, then create+start.
      await this.docker.removeByServerId(id).catch(() => undefined);
      await this.docker.pullImage(spec.Image as string).catch((e) =>
        this.logger.warn(`pull skipped: ${(e as Error).message}`),
      );
      const containerId = await this.docker.createContainer(spec);
      // Container now reflects the current config → clear the restart-needed flag.
      await this.prisma.server.update({ where: { id }, data: { containerId, configDirty: false } });
      await this.docker.start(containerId);

      await this.attachMonitors(id, containerId);
    } catch (err) {
      await this.sm.transition(id, ServerState.Crashed, { error: (err as Error).message });
      throw new BadRequestException(`Start failed: ${(err as Error).message}`);
    }
  }

  /**
   * Validate + move to Stopping synchronously (so the caller gets a fast 200 or a
   * 400), then run the actual save + graceful shutdown in the BACKGROUND under the
   * lock. The shutdown can take a while (the world save on exit), and the realtime
   * badge tracks Stopping -> Stopped — so the HTTP request must not block on it,
   * which is what caused the request to hang/500.
   */
  async stop(id: string, _opts: { snapshot?: boolean } = {}): Promise<void> {
    // Serialize with any in-flight lifecycle op on this server (same as withLock).
    while (this.locks.has(id)) await this.locks.get(id);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    this.locks.set(id, held);
    void held.finally(() => this.locks.delete(id));
    try {
      const server = await this.prisma.server.findUnique({ where: { id } });
      if (!server) throw new NotFoundException("Server not found");
      const state = server.state as ServerState;
      if (![ServerState.Running, ServerState.Starting].includes(state)) {
        throw new BadRequestException(`Cannot stop from state ${state}`);
      }
      await this.sm.transition(id, ServerState.Stopping);
      // Background teardown; holds the lock (so a follow-on start/restart waits for
      // it) and releases on completion.
      void this.tearDownStopped(id, server.containerId).finally(() => release());
    } catch (err) {
      release();
      throw err;
    }
  }

  /**
   * The actual shutdown, run detached from the HTTP request.
   *
   * Order matters and every step is bounded so a stop can never hang for minutes:
   *  1. Save the world and WAIT for ARK's "World Save Complete" (capped) so no
   *     progress is lost — we do this OURSELVES rather than trusting POK's
   *     SIGTERM handler, which doesn't reliably save.
   *  2. SIGTERM with a SHORT grace, then force-remove. We don't give POK a long
   *     graceful window: on SIGTERM it often relaunches ARK instead of exiting,
   *     so a 180s grace just meant the container lingered for minutes. Since the
   *     save is already on disk, a brief SIGTERM-then-SIGKILL is safe.
   *  3. force-remove by label GUARANTEES the container is gone even if `stop`
   *     misbehaved or the containerId was stale — so the server can never get
   *     wedged in "Stopping" with a live container.
   */
  private async tearDownStopped(id: string, containerId: string | null): Promise<void> {
    this.stopping.add(id); // suppress the crash watchdog for this deliberate exit
    try {
      await this.saveAndWaitForSave(id, containerId);
      await this.rcon.disconnect(id).catch(() => undefined);

      this.logStops.get(id)?.();
      this.logStops.delete(id);

      if (containerId) {
        // 20s SIGTERM courtesy, then the daemon SIGKILLs — bounded at ~20s.
        // Wrapped so even a hung docker API call can't block the force-remove.
        await this.withTimeout(this.docker.stop(containerId, 20), 30_000).catch((e) =>
          this.logger.warn(`stop(${id}): docker stop failed/slow: ${(e as Error).message}`),
        );
      }
      // The guarantee: kill + remove anything still labelled for this server.
      await this.docker.removeByServerId(id).catch((e) =>
        this.logger.warn(`stop(${id}): force-remove failed: ${(e as Error).message}`),
      );
      await this.prisma.server
        .update({ where: { id }, data: { containerId: null } })
        .catch(() => undefined);
      await this.sm.transition(id, ServerState.Stopped).catch(() => undefined);
      this.logger.log(`stop(${id}): teardown complete → Stopped`);
    } finally {
      this.stopping.delete(id);
    }
  }

  /** Resolve `p`, or resolve to undefined after `ms` — so a slow/hung step can't
   *  block the rest of a teardown. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    return Promise.race([
      p,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
    ]);
  }

  /**
   * Issue SaveWorld and resolve only once ARK logs "World Save Complete" — the
   * definitive signal that the save is on disk. (The SaveWorld RCON reply is
   * unreliable, which is why we watch the log instead.) Falls back after a
   * timeout so a missing line can't hang the shutdown forever.
   */
  private async saveAndWaitForSave(
    id: string,
    containerId: string | null,
    timeoutMs = 30_000,
  ): Promise<void> {
    // Conan persists to a SQLite DB and never logs "World Save Complete" — issue its
    // save (DoServerSaveAll, via the game-aware wrapper) and return; SIGTERM flushes
    // the DB on shutdown. Waiting for the ARK log here would just burn the timeout.
    const row = await this.prisma.server.findUnique({ where: { id }, select: { game: true } });
    const game = row?.game as Game;
    // Conan persists to SQLite and Minecraft never logs ARK's "World Save Complete"
    // — issue their save (save-all for Minecraft, via the game-aware wrapper) and
    // return; the container's SIGTERM handler flushes the rest on shutdown. Waiting
    // for the ARK log here would just burn the timeout. Icarus has NO RCON at all —
    // it autosaves its prospect and flushes on the container's graceful shutdown, so
    // there's nothing to issue; just return and let SIGTERM handle it.
    if (game === Game.ICARUS) return;
    if (!containerId || game === Game.CONAN || game === Game.MINECRAFT) {
      await this.rcon.saveWorld(id).catch(() => undefined);
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let stop = () => {};
      const finish = (saved: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop();
        if (saved) {
          this.logger.log(`stop(${id}): world saved`);
        } else {
          this.logger.warn(`No "World Save Complete" for ${id} within ${timeoutMs}ms — stopping anyway`);
        }
        resolve();
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      // tail:0 → only lines from now on, so we catch THIS save's completion, not an
      // old autosave already in the history.
      void this.docker
        .followLogs(
          containerId,
          (line) => {
            if (/World Save Complete/i.test(line)) finish(true);
          },
          0,
        )
        .then((s) => {
          stop = s;
          void this.rcon.saveWorld(id).catch(() => undefined); // trigger the save now we're listening
        })
        .catch(() => finish(false)); // can't follow logs → don't block the stop
    });
  }

  async restart(id: string): Promise<void> {
    await this.stop(id).catch(() => undefined);
    await this.start(id);
  }

  // ── Monitors: readiness + crash watchdog ────────────────────────────────────
  private async attachMonitors(id: string, containerId: string): Promise<void> {
    // Seed the per-run capture with the current container log (full, capped), then
    // follow only NEW lines so nothing duplicates. On a fresh start the log is
    // ~empty (wiping the run); on adopt-after-restart it restores the run's log.
    const seed = await this.docker.tailLogs(containerId, LOG_CAPTURE_MAX).catch(() => "");
    this.logCapture.seed(id, seed ? seed.split("\n").filter((l) => l.length > 0) : []);

    const stop = await this.docker.followLogs(
      containerId,
      (line) => {
        this.logCapture.recordLog(id, line);
        this.realtime.broadcast({
          topic: RealtimeTopic.ServerLog,
          serverId: id,
          payload: { line },
          at: new Date().toISOString(),
        });
        if (READY_RE.test(line)) void this.onReady(id);
      },
      0, // only new lines — the seed holds the backlog
    );
    this.logStops.set(id, stop);

    // Crash detection: wait for the container to exit unexpectedly.
    void this.docker.client
      .getContainer(containerId)
      .wait()
      .then(() => this.onContainerExit(id))
      .catch(() => undefined);
  }

  private async onReady(id: string): Promise<void> {
    const state = await this.sm.current(id).catch(() => null);
    if (state !== ServerState.Starting) return; // already Running → fires once
    await this.sm.transition(id, ServerState.Running);
    // First successful install seeds the golden cache for future servers.
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (server) {
      void this.installer
        .seedGameFilesCache(id, server.game as Game)
        .catch((e) => this.logger.warn(`cache seed failed: ${(e as Error).message}`));
    }
  }

  private async onContainerExit(id: string): Promise<void> {
    // Deliberate stop in progress → the teardown owns this exit, never a crash.
    if (this.stopping.has(id)) return;
    const state = await this.sm.current(id).catch(() => null);
    // Expected stop → ignore; we already drive Stopping/Stopped explicitly.
    if (!state || ![ServerState.Running, ServerState.Starting].includes(state)) return;

    const now = Date.now();
    const recent = (this.crashTimes.get(id) ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
    recent.push(now);
    this.crashTimes.set(id, recent);

    await this.sm.transition(id, ServerState.Crashed);
    if (recent.length >= CRASH_LIMIT) {
      await this.events.emit({
        type: EventType.Warning,
        message: `Server crashed ${recent.length}x in 5 min — auto-restart paused (loop guard)`,
        serverId: id,
      });
      return;
    }
    await this.events.emit({
      type: EventType.Warning,
      message: `Server crashed — auto-restarting (${recent.length}/${CRASH_LIMIT})`,
      serverId: id,
    });
    await this.start(id).catch((e) =>
      this.logger.error(`auto-restart failed: ${(e as Error).message}`),
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────---
  private portsOf(server: { gamePort: number; rawSocketPort: number; queryPort: number; rconPort: number }) {
    return {
      game: server.gamePort,
      rawSocket: server.rawSocketPort,
      query: server.queryPort,
      rcon: server.rconPort,
    };
  }

  private async writeInis(server: ServerRow): Promise<void> {
    if (!server) return;
    const env = loadEnv();
    const game = server.game as Game;
    // Env-driven images build their own config: Minecraft (itzg) writes
    // server.properties, Icarus (mornedhels) writes ServerSettings.ini — neither
    // has ARK-style INI files for us to render. Nothing to write.
    if (game === Game.MINECRAFT || game === Game.ICARUS) return;
    const base = join(env.DATA_DIR, "instances", server.id);
    // Both images bind the instance dir as their data root. ASA (POK) installs
    // at the root → config under ShooterGame/Saved/Config/WindowsServer; ASE
    // (hermsi) installs under server/ → ShooterGame/Saved/Config/LinuxServer.
    const dir =
      game === Game.ASA
        ? join(base, "ShooterGame", "Saved", "Config", "WindowsServer")
        : join(base, "server", "ShooterGame", "Saved", "Config", "LinuxServer");
    await mkdir(dir, { recursive: true });
    const { gameUserSettings, game: gameIni } = this.catalog.renderInis(
      game,
      JSON.parse(server.configJson) as ServerConfigValues,
    );
    await writeFile(join(dir, "GameUserSettings.ini"), gameUserSettings, "utf8");
    await writeFile(join(dir, "Game.ini"), gameIni, "utf8");
    // The images run as a fixed non-root user and write throughout the data dir
    // (POK creates Saved/SavedArks + Saved/Logs and edits the INIs in place). We
    // create the config path as root, so chown the WHOLE chain from the instance
    // root down to the config dir — otherwise the runtime user can't create its
    // own subdirs under our root-owned Saved/Config parents.
    const chain = [base];
    let cur = base;
    for (const seg of relative(base, dir).split(sep)) {
      cur = join(cur, seg);
      chain.push(cur);
    }
    await this.makeServerWritable(
      game,
      ...chain,
      join(dir, "GameUserSettings.ini"),
      join(dir, "Game.ini"),
    );
  }

  /**
   * Make paths writable by a game image's fixed runtime uid/gid (POK=7777,
   * hermsi=1000) — neither fully chowns the dirs the manager injects. Best-effort:
   * chown needs the manager to run as root (true in the deployed container, a
   * harmless no-op in local dev).
   */
  private async makeServerWritable(game: Game, ...paths: string[]): Promise<void> {
    for (const p of paths) {
      await chmod(p, 0o775).catch(() => undefined);
      await chown(p, SERVER_UID[game], SERVER_GID[game]).catch(() => undefined);
    }
  }

  private toSummary(row: ServerRow, imageReady = false): ServerSummary {
    if (!row) throw new NotFoundException("Server not found");
    // Join password is shown so it can be copied for the in-game prompt. Prefer the
    // plain-text catalog value (ARK's ServerPassword), else fall back to the
    // first-class encrypted field (how Conan + the create/edit form set it).
    const catalogPw = (JSON.parse(row.configJson) as ServerConfigValues).values?.["ServerPassword"];
    let joinPassword: string | null =
      typeof catalogPw === "string" && catalogPw.trim() ? catalogPw : null;
    if (!joinPassword && row.serverPasswordEnc) {
      try {
        joinPassword = this.crypto.decrypt(row.serverPasswordEnc) || null;
      } catch {
        /* undecryptable — treat as unset */
      }
    }
    return {
      id: row.id,
      name: row.name,
      game: row.game as Game,
      map: row.map,
      state: row.state as ServerState,
      clusterId: row.clusterId,
      ports: this.portsOf(row) ?? DEFAULT_PORTS,
      installedBuildId: row.installedBuildId,
      updateAvailable: row.updateAvailable,
      imageReady,
      configDirty: row.configDirty,
      joinPassword,
      hasAdminPassword: Boolean(row.adminPasswordEnc),
      playersOnline: null,
      maxPlayers: row.maxPlayers,
      modIds: JSON.parse(row.modIds) as number[],
      ramLimitMb: row.ramLimitMb,
      cpuLimit: row.cpuLimit,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
