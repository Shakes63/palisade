import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type Docker from "dockerode";
import { mkdir, writeFile, rm, cp, chmod, chown, stat, readFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
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
import { BackupsService } from "../backups/backups.service";
import { PlayersService } from "../players/players.service";
import {
  buildContainerSpec,
  renderSdtdServerXml,
  renderSotfConfig,
  patchLifWorldXml,
  patchAtsServerConfig,
  patchTShockConfig,
  patchFactorioSettings,
} from "./runtime-spec";
import { portsFor, serverPortSet } from "../catalog/ports";
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
// once when the world has finished loading and it accepts joins (and RCON).
//
// Icarus (mornedhels, no RCON): the Unreal server binds its game port and the
// GameMode reaches the lobby ("WaitingToStart") — verified against a real boot.
//
// Readiness is now GAME-SPECIFIC and each regex is tested only against its own
// server's container logs (see attachMonitors), so a marker for one game can never
// flip another. This matters because these are different engines that share generic
// lines — e.g. "Engine is initialized" is Conan's too-EARLY line yet coincides with
// Icarus being up, and both ARK images are Unreal like Icarus.
export const READY_RE_BY_GAME: Record<Game, RegExp> = {
  // POK logs "advertising for join" (ASA); hermsi logs "server is up" (ASE). Both
  // ARK images keep both alternatives (unchanged from the old shared marker).
  [Game.ASA]: /(advertising for join(?!')|server is up)/i,
  [Game.ASE]: /(advertising for join(?!')|server is up)/i,
  [Game.CONAN]: /Startup report\. StartupTime=/i,
  [Game.PALWORLD]: /Running Palworld dedicated server/i,
  [Game.MINECRAFT]: /Done \([\d.]+s\)! For help/i,
  [Game.ICARUS]: /Match State Changed from EnteringMap to WaitingToStart|SteamNetDriver_\w+ bound to port/i,
  // Bedrock's dedicated server prints "Server started." once it's up (no RCON to
  // lean on). PROVISIONAL — confirm against a real boot.
  [Game.BEDROCK]: /Server started\./i,
  // Valheim logs "Game server connected" when it registers + is joinable (no RCON).
  // PROVISIONAL — confirm against a real boot.
  [Game.VALHEIM]: /Game server connected/i,
  // 7 Days to Die: "StartGame done" (immediately followed by "GameServer.LogOn
  // successful") is the truly-joinable line — CONFIRMED live. NOT "Started Telnet
  // on 8081", which fires ~60 s earlier while the world is still loading.
  [Game.SEVEN_DAYS]: /StartGame done|GameServer\.LogOn successful/i,
  // Enshrouded logs "'HostOnline' (up)!" once the session is registered + joinable
  // (no RCON to lean on). PROVISIONAL — confirm against a real boot.
  [Game.ENSHROUDED]: /'HostOnline' \(up\)/i,
  // Project Zomboid prints "SERVER STARTED" once the world is loaded + joinable.
  // CONFIRMED live: the exact line is "*** SERVER STARTED ****".
  [Game.ZOMBOID]: /SERVER STARTED/i,
  // V Rising logs this once the server registers with Steam and is joinable.
  // CONFIRMED live: "PlatformSystemBase - Server connected to Steam successfully!".
  [Game.VRISING]: /Server connected to Steam successfully/i,
  // Sons of the Forest: "#DSL Dedicated server loaded." fires once the world has
  // loaded and the server idles waiting for players — CONFIRMED live. (The earlier
  // "Starting server..." line fires ~2 min before, mid world-load.)
  [Game.SOTF]: /Dedicated server loaded/i,
  // Satisfactory: Unreal's "Engine is initialized. Leaving FEngineLoop::Init()"
  // fires right as the game port starts listening — CONFIRMED live (the API
  // claim + query follow within seconds).
  [Game.SATISFACTORY]: /Engine is initialized\. Leaving FEngineLoop::Init|Satisfactory Server is now running/i,
  // LiF:YO: the game logs "Server is up and ready to accept connections" after the
  // DB import + world/navmesh generation — CONFIRMED live (the TCP listener line
  // and Steam registration follow within seconds). NOT the wrapper's "---Server
  // ready---", which fires BEFORE the wine launch.
  [Game.LIF]: /Server is up and ready to accept connections/i,
  // ATS: the true ready line ("[MP] Session running.") goes to the game's OWN log
  // file (server.log.txt), not stdout — docker logs end at "[MP] Server init",
  // which the file's timestamps show is <2 s before the session is up (CONFIRMED
  // live). So the stdout init line is the marker; the tiny early window is fine.
  [Game.ATS]: /\[MP\] Server init/i,
  // ETS2: same engine + wrapper as ATS — same stdout marker.
  [Game.ETS2]: /\[MP\] Server init/i,
  // Core Keeper logs "Started session with info: <GameID>" the moment the session
  // is registered on Steam's relay and joinable — CONFIRMED live. (The early
  // "failed to initialize steam." line is a non-fatal first try; the retry
  // succeeds and "Listening on SteamID" precedes this marker.)
  [Game.CORE_KEEPER]: /Started session with info/i,
  // Terraria/TShock prints "Listening on port 7777" (then "Server started") once
  // the world is loaded and joinable — CONFIRMED live (both lines real).
  [Game.TERRARIA]: /Listening on port|Server started/i,
  // Factorio logs a state transition to InGame exactly when the map is loaded and
  // the server takes joins — CONFIRMED live.
  [Game.FACTORIO]: /changing state from\(CreatingGame\) to\(InGame\)/i,
  // Rust prints "Server startup complete" after the (long) map generation, right
  // as it takes joins — CONFIRMED live.
  [Game.RUST]: /Server startup complete/i,
  // BeamMP prints an unmistakable all-caps line once fully up. PROVISIONAL —
  // confirm against a real boot.
  [Game.BEAMMP]: /ALL SYSTEMS STARTED SUCCESSFULLY|Vehicle data network online/i,
};

/** The "server is now joinable" log-marker regex for a game. */
export function readyReFor(game: Game): RegExp {
  return READY_RE_BY_GAME[game];
}
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
  /** When the last teardown finished — lets the RAM guard debounce the window in
   *  which the freed memory isn't yet visible in /proc/meminfo (restart races). */
  private lastStopCompletedAt = 0;

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
    private readonly backups: BackupsService,
    private readonly players: PlayersService,
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
        await this.adoptRunning(server.id, c.id, dbState, server.game as Game);
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
    game: Game,
  ): Promise<void> {
    await this.prisma.server
      .update({ where: { id: serverId }, data: { containerId } })
      .catch(() => undefined);
    // It's alive → it should be Running, unless its logs show it's still booting.
    let target = ServerState.Running;
    if (dbState === ServerState.Starting) {
      const log = await this.docker.tailLogs(containerId, 5000).catch(() => "");
      target = readyReFor(game).test(log) ? ServerState.Running : ServerState.Starting;
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

  /** Whole-machine stats (dashboard disk-space warning). */
  hostStats() {
    return hostStats(loadEnv().DATA_DIR);
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
    // Player counts come from PlayersService's short-TTL cache, so polling every 5 s
    // only actually queries the game server every ~20 s.
    const players = live ? await this.players.count(serverId) : null;
    return {
      live: !!live,
      cpuPercent: live?.cpuPercent ?? null,
      memUsedMb: live?.memUsedMb ?? null,
      memLimitMb: live?.memLimitMb ?? null,
      diskUsedMb: this.diskUsedMb(serverId),
      playersOnline: players?.online ?? null,
      playersMax: players?.max ?? null,
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

  /** Join info beyond IP:port — currently Core Keeper's relay Game ID, read from
   *  the GameID.txt the server writes next to its executable on (first) boot. */
  async joinInfo(id: string): Promise<{ gameId: string | null }> {
    const row = await this.prisma.server.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Server not found");
    if ((row.game as Game) !== Game.CORE_KEEPER) return { gameId: null };
    const file = join(LocalPaths.instanceRoot(id), "files", "GameID.txt");
    const gameId = await readFile(file, "utf8").then((t) => t.trim() || null).catch(() => null);
    return { gameId };
  }

  async getConfig(id: string): Promise<ServerConfigValues> {
    const row = await this.prisma.server.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Server not found");
    return JSON.parse(row.configJson) as ServerConfigValues;
  }

  async create(dto: CreateServerDto): Promise<ServerSummary> {
    if (!Object.values(Game).includes(dto.game)) throw new BadRequestException("Invalid game");
    // Valheim's server refuses to boot without a join password of >= 5 characters.
    if (dto.game === Game.VALHEIM && (dto.serverPassword ?? "").length < 5) {
      throw new BadRequestException("Valheim requires a server password of at least 5 characters.");
    }
    // Enshrouded's join password is role-based; we derive the roles from it and it
    // must be present + non-trivial (>= 5 chars, matching Valheim's rule).
    if (dto.game === Game.ENSHROUDED && (dto.serverPassword ?? "").length < 5) {
      throw new BadRequestException("Enshrouded requires a server password of at least 5 characters.");
    }
    // Project Zomboid refuses first boot without an admin password (it also gates RCON).
    if (dto.game === Game.ZOMBOID && (dto.adminPassword ?? "").length < 5) {
      throw new BadRequestException("Project Zomboid requires an admin password of at least 5 characters.");
    }
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
    // Ports: editable only while the server is down (they're baked into the container
    // port bindings + rendered configs). Changing the game port also moves its
    // derived siblings — the raw-socket slot, and the query port on games where the
    // engine fixes it relative to the game port (Valheim +1, 7DTD +2).
    {
      const ports: Record<string, number> = {};
      if (dto.gamePort !== undefined && dto.gamePort !== existing.gamePort) {
        const g = dto.gamePort;
        ports.gamePort = g;
        const game = existing.game as Game;
        if (game === Game.VALHEIM) {
          ports.queryPort = g + 1;
          ports.rawSocketPort = g + 2; // crossplay backend
        } else if (game === Game.SEVEN_DAYS) {
          ports.rawSocketPort = g + 1;
          ports.queryPort = g + 2;
        } else if (game === Game.MINECRAFT) {
          ports.queryPort = g; // Java has no separate query; column mirrors the game port
          ports.rawSocketPort = g + 1;
        } else {
          ports.rawSocketPort = g + 1;
        }
      }
      // Explicit query/rcon edits override any derived value above.
      if (dto.queryPort !== undefined && dto.queryPort !== existing.queryPort) ports.queryPort = dto.queryPort;
      if (dto.rconPort !== undefined && dto.rconPort !== existing.rconPort) ports.rconPort = dto.rconPort;
      if (Object.keys(ports).length > 0) {
        if (![ServerState.Stopped, ServerState.Crashed].includes(existing.state as ServerState)) {
          throw new BadRequestException("Stop the server before changing its ports.");
        }
        for (const v of Object.values(ports)) {
          if (v < 1024 || v > 65535) throw new BadRequestException(`Port ${v} is out of range (1024–65535).`);
        }
        Object.assign(data, ports);
        launchChanged = true;
      }
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
    // Resource limits: 0 clears the cap (stored as null = unlimited).
    if (dto.ramLimitMb !== undefined) {
      const next = dto.ramLimitMb === 0 ? null : dto.ramLimitMb;
      if (next !== existing.ramLimitMb) {
        data.ramLimitMb = next;
        launchChanged = true;
      }
    }
    if (dto.cpuLimit !== undefined) {
      const next = dto.cpuLimit === 0 ? null : dto.cpuLimit;
      if (next !== existing.cpuLimit) {
        data.cpuLimit = next;
        launchChanged = true;
      }
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

  async remove(id: string, opts: { wipeFiles?: boolean } = {}): Promise<void> {
    const wipeFiles = opts.wipeFiles ?? true;
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
    // With wipeFiles (the default), delete the server entirely: the on-disk instance
    // (game files + saves) AND the backups, so nothing is orphaned on the array.
    // Best-effort — the DB row is already gone, so a filesystem hiccup can't strand a
    // half-deleted server. The UI asks before calling here; unchecking the wipe keeps
    // the files on disk for a later manual import.
    if (wipeFiles) {
      const env = loadEnv();
      await rm(LocalPaths.instanceRoot(id), { recursive: true, force: true }).catch((e) =>
        this.logger.warn(`Delete: instance dir cleanup failed for ${id}: ${(e as Error).message}`),
      );
      await rm(join(env.DATA_DIR, "backups", id), { recursive: true, force: true }).catch((e) =>
        this.logger.warn(`Delete: backups cleanup failed for ${id}: ${(e as Error).message}`),
      );
    }
    await this.events.emit({
      type: EventType.ServerDeleted,
      message: `Deleted server "${server.name}"${wipeFiles ? "" : " (files kept on disk)"}`,
      serverId: id,
    });
  }

  /**
   * Stream the server's save data (the per-game saveSubpaths — worlds, configs,
   * prospects…) as a tar.gz, so it can be downloaded through the browser before a
   * delete. Only the save subpaths are archived, NOT the multi-GB game install.
   * Returns the spawned tar's stdout; tar reads the (often root-owned) files fine
   * because the manager runs as root.
   */
  async downloadSaves(id: string): Promise<{ stream: Readable; filename: string }> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("Server not found");
    const root = LocalPaths.instanceRoot(id);
    const existing: string[] = [];
    for (const sub of LocalPaths.saveSubpaths(server.game as Game)) {
      if (await stat(join(root, sub)).catch(() => null)) existing.push(sub);
    }
    if (existing.length === 0) {
      throw new NotFoundException("No save data on disk yet — the server hasn't created a world.");
    }
    const tar = spawn("tar", ["czf", "-", "-C", root, ...existing]);
    tar.on("error", (e) => this.logger.warn(`Save download tar failed for ${id}: ${e.message}`));
    tar.stderr.on("data", (d: Buffer) => this.logger.warn(`tar: ${d.toString().trim()}`));
    const slug = server.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
    return { stream: tar.stdout, filename: `${slug}-saves.tar.gz` };
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
      // Swap: back up the outgoing server, then stop it (freeing RAM), then start
      // this one. The backup is best-effort — the graceful stop also saves the world
      // — so a backup hiccup can't strand the swap. stop() returns once teardown
      // begins but holds the server's lock until it completes; await that so the RAM
      // is actually reclaimed before we launch.
      await this.backups
        .create(opts.stopFirst, "auto-stop")
        .catch((e) => this.logger.warn(`auto-stop backup of ${opts.stopFirst} failed: ${(e as Error).message}`));
      await this.stop(opts.stopFirst).catch(() => undefined);
      await this.locks.get(opts.stopFirst)?.catch(() => undefined);
    } else if (!opts.force) {
      await this.assertRamAvailable(id);
    }
    return this.withLock(id, () => this.doStart(id));
  }

  /** Throw a 409 (with the running servers + RAM) if starting `id` would exceed the
   *  host's free RAM. A server's ramLimitMb overrides the per-game estimate.
   *
   *  Debounce: right after a container stops (a restart, or a start racing a
   *  manual stop), the freed memory takes a few seconds to show up in
   *  /proc/meminfo — a naive single sample rejects a 12 GB game on a box that's
   *  about to have 18 GB free (seen live with Sons of the Forest). So when the
   *  first sample fails INSIDE that post-stop window, re-sample for up to ~15 s
   *  before giving up. A failure with no recent stop still rejects instantly,
   *  keeping the swap dialog snappy in the genuine-shortage case. */
  private async assertRamAvailable(id: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException("Server not found");
    const needMb = server.ramLimitMb ?? RAM_ESTIMATE_MB[server.game as Game];

    const RECENT_STOP_WINDOW_MS = 30_000;
    const RETRY_DELAY_MS = 3_000;
    const MAX_RETRIES = 5;

    let sample = await this.sampleAvailableRam();
    let retries = 0;
    while (
      needMb > sample.availableMb &&
      retries < MAX_RETRIES &&
      (this.stopping.size > 0 || Date.now() - this.lastStopCompletedAt < RECENT_STOP_WINDOW_MS)
    ) {
      retries += 1;
      this.logger.log(
        `RAM guard: ${needMb}MB needed, ${sample.availableMb}MB free just after a stop — re-sampling (${retries}/${MAX_RETRIES})`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      sample = await this.sampleAvailableRam();
    }
    if (needMb <= sample.availableMb) return;
    throw new ConflictException({
      code: "INSUFFICIENT_RAM",
      needMb,
      availableMb: sample.availableMb,
      totalMb: sample.totalMb,
      running: sample.running,
      autoStop: await this.settings.getAutoStopOnStart(),
    } satisfies InsufficientRamInfo);
  }

  /** One free-RAM measurement: host free memory minus each running server's
   *  remaining headroom up to its peak estimate — so a not-yet-peaked server
   *  (e.g. an empty one that fills up) can't OOM the box after we start another.
   *  Headroom is 0 when we can't read a server's usage. */
  private async sampleAvailableRam(): Promise<{
    availableMb: number;
    totalMb: number;
    running: RunningServerRam[];
  }> {
    const host = await hostStats(loadEnv().DATA_DIR);
    const running = await this.runningServersRam();
    const reservedMb = running.reduce((sum, r) => {
      const est = RAM_ESTIMATE_MB[r.game];
      return sum + Math.max(0, est - (r.ramUsedMb ?? est));
    }, 0);
    return {
      availableMb: Math.max(0, host.memTotalMb - host.memUsedMb - reservedMb),
      totalMb: host.memTotalMb,
      running,
    };
  }

  /** Currently-running servers with their live RAM + players, for the start-guard
   *  dialog (so stopping one shows who'd be interrupted). */
  private async runningServersRam(): Promise<RunningServerRam[]> {
    const rows = await this.prisma.server.findMany({ where: { state: { in: LIVE_STATES } } });
    return Promise.all(
      rows.map(async (r) => {
        const st = r.containerId ? await this.docker.stats(r.containerId).catch(() => null) : null;
        const players = await this.players.count(r.id).catch(() => null);
        return {
          id: r.id,
          name: r.name,
          game: r.game as Game,
          ramUsedMb: st?.memUsedMb ?? null,
          playersOnline: players?.online ?? null,
        };
      }),
    );
  }

  /**
   * Throw a 409 if any of this server's host ports are already bound by another
   * live server (Running/Starting/Stopping — its ports are still held until the
   * teardown finishes). Compares full port sets, so it catches same-game servers
   * sharing the fixed block AND cross-game collisions from manual port edits.
   */
  private async assertPortsFree(server: ServerRow): Promise<void> {
    const mine = serverPortSet(server.game as Game, this.portsOf(server) ?? DEFAULT_PORTS);
    const live = await this.prisma.server.findMany({
      where: { state: { in: LIVE_STATES }, id: { not: server.id } },
    });
    for (const other of live) {
      const theirs = serverPortSet(other.game as Game, this.portsOf(other) ?? DEFAULT_PORTS);
      const clash = [...mine].filter((p) => theirs.has(p));
      if (clash.length > 0) {
        throw new ConflictException(
          `Port conflict: ${clash.join(", ")} ${clash.length === 1 ? "is" : "are"} already in use by ` +
            `running server "${other.name}". Stop it first, or change one server's ports (Overview → Ports).`,
        );
      }
    }
  }

  /** assembleSpec by server id (fetches the row + cluster). */
  async specForServer(id: string): Promise<Docker.ContainerCreateOptions> {
    const server = (await this.prisma.server.findUnique({
      where: { id },
      include: { cluster: true },
    })) as ServerRow;
    if (!server) throw new NotFoundException("Server not found");
    return this.assembleSpec(server);
  }

  /** Assemble the full Docker create spec for a server row — decrypted
   *  passwords, catalog, mods, timezone. Shared by start() and by container
   *  adoption (which needs the spec's Binds to map foreign volume data in). */
  async assembleSpec(server: ServerRow): Promise<Docker.ContainerCreateOptions> {
    const game = server.game as Game;
    // Both ARK images install their own mods on first boot (POK via MOD_IDS,
    // hermsi via `arkmanager installmod`), so nothing to pre-download here.
    const modIds = JSON.parse(server.modIds) as number[];

    // Project Zomboid activates mods by their in-game "Mod ID" names (Mods=),
    // parsed from each Workshop description at install and stored on Mod.extra.
    let pzModNames: string[] | undefined;
    if (game === Game.ZOMBOID) {
      const installs = await this.prisma.modInstall.findMany({
        where: { serverId: server.id, enabled: true },
        include: { mod: true },
        orderBy: { loadOrder: "asc" },
      });
      pzModNames = installs.flatMap((i) => {
        try {
          return (JSON.parse(i.mod.extra ?? "{}") as { pzModIds?: string[] }).pzModIds ?? [];
        } catch {
          return [];
        }
      });
    }

    return buildContainerSpec({
      serverId: server.id,
      game,
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
      catalog: this.catalog.getCatalog(game),
      ramLimitMb: server.ramLimitMb,
      cpuLimit: server.cpuLimit,
      timezone: await this.settings.getTimezone(),
      // Minecraft only: lets itzg auto-install a selected CurseForge modpack.
      curseForgeApiKey:
        game === Game.MINECRAFT ? await this.settings.get(SettingKeys.CurseForgeApiKey) : null,
      pzModNames,
    });
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
    // Same-family servers share one fixed port block by design ("one at a time"),
    // so starting a second one while the first is up would fail with a cryptic
    // Docker bind error (bridge) or clash on the host (host networking). Catch it
    // up front with a clear message instead. Not bypassed by force — that flag is
    // for the RAM guard; a port clash can never work.
    await this.assertPortsFree(server);

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

      // Bedrock's itzg image drops to UID/GID (env.PUID/PGID) and writes throughout
      // /data (starting with /data/.tmp) — but a freshly bind-mounted instance dir is
      // root-owned, so it can't, and the server exits. (The Java image chowns /data
      // itself; the Bedrock one doesn't.) Own the instance root as the runtime user
      // before launch so the first boot can write.
      if (game === Game.BEDROCK) {
        const env = loadEnv();
        const root = LocalPaths.instanceRoot(id);
        await mkdir(root, { recursive: true });
        await chown(root, Number(env.PUID), Number(env.PGID)).catch(() => undefined);
      }

      // Same failure mode for Zomboid: the danixu86 image runs as its fixed "steam"
      // user (1000) and writes throughout the Zomboid data bind, but Docker creates a
      // missing bind dir root-owned. Pre-create + own it as the runtime user.
      if (game === Game.ZOMBOID) {
        const dataDir = join(LocalPaths.instanceRoot(id), "data");
        await mkdir(dataDir, { recursive: true });
        await chown(LocalPaths.instanceRoot(id), SERVER_UID[game], SERVER_GID[game]).catch(() => undefined);
        await chown(dataDir, SERVER_UID[game], SERVER_GID[game]).catch(() => undefined);
      }

      const spec = await this.assembleSpec(server);

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
      // The kernel takes a few seconds to reflect the freed memory in /proc/meminfo
      // after a container dies — the RAM guard debounces against this timestamp.
      this.lastStopCompletedAt = Date.now();
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
    // for the ARK log here would just burn the timeout. Icarus/Bedrock/Valheim have NO
    // RCON at all, and 7DTD's console is telnet (not wired here) — they autosave and
    // flush on the container's graceful shutdown, so there's nothing to issue; just
    // return and let SIGTERM handle it.
    // V Rising's RCON has no save command either — it autosaves and flushes on the
    // container's graceful shutdown.
    if (
      game === Game.ICARUS ||
      game === Game.BEDROCK ||
      game === Game.VALHEIM ||
      game === Game.SEVEN_DAYS ||
      game === Game.ENSHROUDED ||
      game === Game.VRISING ||
      game === Game.SOTF ||
      game === Game.SATISFACTORY ||
      game === Game.LIF ||
      game === Game.ATS ||
      game === Game.ETS2 ||
      game === Game.CORE_KEEPER ||
      game === Game.TERRARIA ||
      game === Game.BEAMMP
    )
      return;
    if (
      !containerId ||
      game === Game.CONAN ||
      game === Game.MINECRAFT ||
      game === Game.ZOMBOID ||
      game === Game.FACTORIO ||
      game === Game.RUST
    ) {
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

    // Resolve the readiness marker once (per-game) — it's tested against this
    // server's own log lines only.
    const row = await this.prisma.server.findUnique({ where: { id }, select: { game: true } });
    const readyRe = readyReFor(row?.game as Game);

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
        if (readyRe.test(line)) void this.onReady(id);
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
    // Env-driven images build their own config (Minecraft/Bedrock → server.properties,
    // Icarus → ServerSettings.ini, Valheim → launch args, Enshrouded → enshrouded_server.json,
    // V Rising → HOST/GAME_SETTINGS env patching its JSONs, Core Keeper/Rust/BeamMP →
    // pure env) — nothing to render.
    if (
      game === Game.MINECRAFT ||
      game === Game.ICARUS ||
      game === Game.BEDROCK ||
      game === Game.VALHEIM ||
      game === Game.ENSHROUDED ||
      game === Game.VRISING ||
      game === Game.CORE_KEEPER ||
      game === Game.RUST ||
      game === Game.BEAMMP
    )
      return;

    // Project Zomboid: the danixu86 image applies env vars by sed-ing
    // data/Server/servertest.ini — but on FIRST boot that file doesn't exist yet, so
    // none of them (RCON password, join password, display name…) would land until a
    // restart (verified live). Seed a minimal ini holding exactly the keys the
    // image's sed patches, plus MaxPlayers (which has no env var); PZ merges every
    // other default in on boot. On later starts just keep MaxPlayers in sync.
    if (game === Game.ZOMBOID) {
      const dir = join(env.DATA_DIR, "instances", server.id, "data", "Server");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "servertest.ini");
      const exists = await stat(file).then(() => true).catch(() => false);
      if (!exists) {
        const seed = [
          "PublicName=",
          "Public=false",
          "Password=",
          `MaxPlayers=${server.maxPlayers}`,
          `UDPPort=${server.rawSocketPort}`,
          `RCONPort=${server.rconPort}`,
          "RCONPassword=",
          "Mods=",
          "WorkshopItems=",
          "SteamVAC=true",
          "",
        ].join("\n");
        await writeFile(file, seed, "utf8");
      } else {
        const ini = await readFile(file, "utf8");
        const patched = /^MaxPlayers=/m.test(ini)
          ? ini.replace(/^MaxPlayers=.*$/m, `MaxPlayers=${server.maxPlayers}`)
          : `${ini}\nMaxPlayers=${server.maxPlayers}\n`;
        if (patched !== ini) await writeFile(file, patched, "utf8");
      }
      // The image's fixed steam user must be able to rewrite the file on boot.
      await chown(dir, SERVER_UID[game], SERVER_GID[game]).catch(() => undefined);
      await chown(file, SERVER_UID[game], SERVER_GID[game]).catch(() => undefined);
      return;
    }

    // Sons of the Forest: all settings live in userdata/dedicatedserver.cfg (JSON,
    // no env interface) — render it into the game bind. The jammsen entrypoint
    // chowns the whole bind to PUID/PGID on start, so root-written is fine.
    if (game === Game.SOTF) {
      const dir = join(env.DATA_DIR, "instances", server.id, "game", "userdata");
      await mkdir(dir, { recursive: true });
      const cfg = renderSotfConfig({
        sessionName: server.name,
        serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
        maxPlayers: server.maxPlayers,
        map: server.map,
        ports: this.portsOf(server),
        catalog: this.catalog.getCatalog(Game.SOTF),
        config: JSON.parse(server.configJson) as ServerConfigValues,
      });
      await writeFile(join(dir, "dedicatedserver.cfg"), cfg, "utf8");
      return;
    }

    // LiF:YO: all settings live in serverfiles/config/world_1.xml. The file is
    // WRITTEN BY STEAMCMD on the first install (so it can't be pre-seeded — the
    // depot would overwrite it); once present, patch our name/passwords/slots/
    // port + catalog values into it before every start, preserving the rest.
    // On the very first boot the image's own defaults apply; a restart applies ours.
    if (game === Game.LIF) {
      const file = join(env.DATA_DIR, "instances", server.id, "serverfiles", "config", "world_1.xml");
      const xml = await readFile(file, "utf8").catch(() => null);
      if (xml !== null) {
        const patched = patchLifWorldXml(xml, {
          sessionName: server.name,
          serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
          adminPassword: server.adminPasswordEnc ? this.crypto.decrypt(server.adminPasswordEnc) : "",
          maxPlayers: server.maxPlayers,
          gamePort: server.gamePort,
          catalog: this.catalog.getCatalog(Game.LIF),
          config: JSON.parse(server.configJson) as ServerConfigValues,
        });
        if (patched !== xml) await writeFile(file, patched, "utf8");
      }
      return;
    }

    // Factorio: merge server-settings.json in the config bind (the image seeds the
    // full example around our keys) and keep config/rconpw in sync with the admin
    // password — the image only generates a random one when the file is missing.
    if (game === Game.FACTORIO) {
      const dir = join(env.DATA_DIR, "instances", server.id, "data", "config");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "server-settings.json");
      const existing = await readFile(file, "utf8").catch(() => null);
      const patched = patchFactorioSettings(existing, {
        sessionName: server.name,
        serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
        maxPlayers: server.maxPlayers,
        catalog: this.catalog.getCatalog(Game.FACTORIO),
        config: JSON.parse(server.configJson) as ServerConfigValues,
      });
      if (patched !== existing) await writeFile(file, patched, "utf8");
      if (server.adminPasswordEnc) {
        await writeFile(join(dir, "rconpw"), this.crypto.decrypt(server.adminPasswordEnc), "utf8");
      }
      return;
    }

    // Terraria: TShock's config.json lives in the worlds bind (CONFIGPATH). Merge
    // our first-class fields + catalog keys into it before every start; TShock
    // fills in / rewrites all its other defaults on boot.
    if (game === Game.TERRARIA) {
      const dir = join(env.DATA_DIR, "instances", server.id, "worlds");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "config.json");
      const existing = await readFile(file, "utf8").catch(() => null);
      const patched = patchTShockConfig(existing, {
        sessionName: server.name,
        serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
        adminPassword: server.adminPasswordEnc ? this.crypto.decrypt(server.adminPasswordEnc) : "",
        maxPlayers: server.maxPlayers,
        gamePort: server.gamePort,
        restPort: server.rconPort,
        catalog: this.catalog.getCatalog(Game.TERRARIA),
        config: JSON.parse(server.configJson) as ServerConfigValues,
      });
      if (patched !== existing) await writeFile(file, patched, "utf8");
      return;
    }

    // ATS/ETS2: settings live in server_config.sii inside the game's save dir. The
    // ich777 image seeds it (with the bundled server_packages world export) on
    // FIRST boot only — so it can't be pre-written; once present, patch our
    // lobby name/password/slots/ports + catalog values before every start.
    if (game === Game.ATS || game === Game.ETS2) {
      const file = join(
        env.DATA_DIR,
        "instances",
        server.id,
        "serverfiles",
        ".local",
        "share",
        game === Game.ATS ? "American Truck Simulator" : "Euro Truck Simulator 2",
        "server_config.sii",
      );
      const sii = await readFile(file, "utf8").catch(() => null);
      if (sii !== null) {
        const patched = patchAtsServerConfig(sii, {
          sessionName: server.name,
          serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
          maxPlayers: server.maxPlayers,
          gamePort: server.gamePort,
          queryPort: server.queryPort,
          catalog: this.catalog.getCatalog(game),
          config: JSON.parse(server.configJson) as ServerConfigValues,
        });
        if (patched !== sii) await writeFile(file, patched, "utf8");
      }
      return;
    }

    // 7 Days to Die's settings live in sdtdserver.xml (not env vars) — render it into
    // the serverfiles bind. The vinanrra image chowns the mounts to PUID/PGID on
    // startup, so a root-written file becomes readable to the runtime user.
    if (game === Game.SEVEN_DAYS) {
      const dir = join(env.DATA_DIR, "instances", server.id, "serverfiles");
      await mkdir(dir, { recursive: true });
      const xml = renderSdtdServerXml({
        sessionName: server.name,
        serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
        adminPassword: server.adminPasswordEnc ? this.crypto.decrypt(server.adminPasswordEnc) : "changeme",
        maxPlayers: server.maxPlayers,
        map: server.map,
        gamePort: server.gamePort,
        telnetPort: server.rconPort,
        catalog: this.catalog.getCatalog(Game.SEVEN_DAYS),
        config: JSON.parse(server.configJson) as ServerConfigValues,
      });
      await writeFile(join(dir, "sdtdserver.xml"), xml, "utf8");
      return;
    }

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
      // Cached only — summaries are hot; the stats poll keeps the cache warm.
      playersOnline: this.players.cached(row.id)?.online ?? null,
      maxPlayers: row.maxPlayers,
      modIds: JSON.parse(row.modIds) as number[],
      ramLimitMb: row.ramLimitMb,
      cpuLimit: row.cpuLimit,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
