import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { mkdir, writeFile, rm, cp, chmod, chown } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import {
  Game,
  ServerState,
  LIVE_STATES,
  EventType,
  RealtimeTopic,
  DEFAULT_PORTS,
  type CreateServerDto,
  type UpdateServerDto,
  type ServerSummary,
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
import { ManagerSettingsService } from "../manager-settings/manager-settings.service";
import { buildContainerSpec } from "./runtime-spec";
import { derivePorts, nextBasePort } from "../catalog/ports";
import { LocalPaths } from "../common/paths";
import { IMAGES, SERVER_UID, SERVER_GID } from "../common/images";
import { loadEnv } from "../config/env";

type ServerRow = Awaited<ReturnType<PrismaService["server"]["findUnique"]>> & {
  cluster?: { clusterId: string } | null;
};

// Readiness markers across both runtimes. POK/ASA pipes ARK's own log to stdout
// (`... has successfully started!` / `Full Startup:` / `advertising for join`);
// the hermsi/ASE image instead prints arkmanager's `server is up` on stdout (the
// game's advertising line goes to a file inside the container, not docker logs).
//
// The `(?!')` guards are essential: POK logs a line that QUOTES the markers —
//   Waiting for startup completion markers: 'Full Startup:' or 'Server has
//   completed startup and is now advertising for join'
// Without the lookaheads, that quoted mention matches and flips the server to
// Running the instant it starts booting. The real completion line isn't quoted
// (it ends with `. (NN.NGB Mem)`), so rejecting a trailing single-quote tells
// the two apart — and works whether we test one line or a multi-line blob.
export const READY_RE =
  /(has successfully started|Full Startup:(?!')|advertising for join(?!')|server is up)/i;
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
  ) {}

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

  async getConfig(id: string): Promise<ServerConfigValues> {
    const row = await this.prisma.server.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Server not found");
    return JSON.parse(row.configJson) as ServerConfigValues;
  }

  async create(dto: CreateServerDto): Promise<ServerSummary> {
    if (!Object.values(Game).includes(dto.game)) throw new BadRequestException("Invalid game");
    const allocs = await this.prisma.portAllocation.findMany();
    const base = nextBasePort(allocs.map((a) => a.basePort));
    const ports = derivePorts(base);

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
      await tx.portAllocation.create({ data: { serverId: created.id, basePort: base } });
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
      const env = loadEnv();
      const dest = join(env.DATA_DIR, "instances", summary.id, "Saved");
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
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.map !== undefined) data.map = dto.map;
    if (dto.maxPlayers !== undefined) data.maxPlayers = dto.maxPlayers;
    if (dto.clusterId !== undefined) data.clusterId = dto.clusterId;
    if (dto.modIds !== undefined) data.modIds = JSON.stringify(dto.modIds);
    if (dto.ramLimitMb !== undefined) data.ramLimitMb = dto.ramLimitMb;
    if (dto.cpuLimit !== undefined) data.cpuLimit = dto.cpuLimit;
    if (dto.adminPassword) data.adminPasswordEnc = this.crypto.encrypt(dto.adminPassword);
    if (dto.serverPassword) data.serverPasswordEnc = this.crypto.encrypt(dto.serverPassword);
    if (dto.spectatorPassword)
      data.spectatorPasswordEnc = this.crypto.encrypt(dto.spectatorPassword);
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
      data.configDirty = true; // settings changed — flag a restart if it's running
    }

    const updated = await this.prisma.server.update({
      where: { id },
      data,
      include: { cluster: true },
    });
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

  async start(id: string): Promise<void> {
    return this.withLock(id, () => this.doStart(id));
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
      });

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
    if (!containerId) {
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
    const stop = await this.docker.followLogs(containerId, (line) => {
      this.realtime.broadcast({
        topic: RealtimeTopic.ServerLog,
        serverId: id,
        payload: { line },
        at: new Date().toISOString(),
      });
      if (READY_RE.test(line)) void this.onReady(id);
    });
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
    const serverPassword = (JSON.parse(row.configJson) as ServerConfigValues).values?.[
      "ServerPassword"
    ];
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
      joinPassword: typeof serverPassword === "string" && serverPassword ? serverPassword : null,
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
