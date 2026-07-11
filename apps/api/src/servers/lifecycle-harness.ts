import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game, ServerState } from "@ark/shared";

/**
 * Shared lifecycle E2E harness: drives the REAL ServersService (real state
 * machine, real spec builder, real config writers) against a scripted fake Docker
 * daemon and an in-memory Prisma. Used by both the wiring-regression suite
 * (lifecycle.e2e.test.ts) and the fault-injection suite (chaos.e2e.test.ts).
 *
 * Deliberately NOT mocked: buildContainerSpec, readiness markers, the state
 * machine's legal-transition table, writeInis. Mocked: Docker, the installer's
 * file-copying, RCON, backups.
 */

/** Sets the env the service reads at construction. Call in a beforeAll. */
export async function setupE2eEnv(): Promise<void> {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), "palisade-e2e-"));
}

export interface ServerRow {
  id: string;
  name: string;
  game: string;
  map: string;
  state: string;
  maxPlayers: number;
  gamePort: number;
  rawSocketPort: number;
  queryPort: number;
  rconPort: number;
  adminPasswordEnc: string | null;
  serverPasswordEnc: string | null;
  spectatorPasswordEnc: string | null;
  configJson: string;
  modIds: string;
  containerId: string | null;
  clusterId: string | null;
  cluster: null;
  ramLimitMb: number | null;
  cpuLimit: number | null;
  installedBuildId: string | null;
  updateAvailable: boolean;
  configDirty: boolean;
}

export function makeRow(over: Partial<ServerRow> = {}): ServerRow {
  return {
    id: "srv-e2e",
    name: "E2E Server",
    game: Game.ASA,
    map: "TheIsland_WP",
    state: ServerState.Stopped,
    maxPlayers: 10,
    gamePort: 7777,
    rawSocketPort: 7778,
    queryPort: 7779,
    rconPort: 27020,
    adminPasswordEnc: null,
    serverPasswordEnc: null,
    spectatorPasswordEnc: null,
    configJson: JSON.stringify({ values: {} }),
    modIds: "[]",
    containerId: null,
    clusterId: null,
    cluster: null,
    ramLimitMb: null,
    cpuLimit: null,
    installedBuildId: null,
    updateAvailable: false,
    configDirty: false,
    ...over,
  };
}

/**
 * Records everything the service asks Docker to do, replays scripted logs, and can
 * inject the failures the chaos suite needs: an unexpected container exit
 * ({@link triggerExit}), a hanging stop ({@link hangStop}), and a transient
 * create failure ({@link failCreateOnce}).
 */
export class FakeDocker {
  createdSpecs: Record<string, unknown>[] = [];
  started: string[] = [];
  stopped: string[] = [];
  removed: string[] = [];
  removedByServerId: (string | undefined)[] = [];
  pulled: string[] = [];
  /** Lines fed to the log follower when a container starts. */
  logScript: string[] = [];
  /** When true, docker.stop() never resolves — exercises the teardown timeout. */
  hangStop = false;
  /** When true, the next createContainer throws once (transient daemon error). */
  failCreateOnce = false;

  private lineHandlers = new Map<string, (line: string) => void>();
  private exitResolvers = new Map<string, () => void>();

  client = {
    getContainer: (id: string) => ({
      wait: () =>
        new Promise<void>((resolve) => {
          this.exitResolvers.set(id, resolve);
        }),
    }),
  };

  /** Simulate the container process exiting on its own (a crash). Resolves the
   *  wait() the crash watchdog is awaiting for `containerId` (defaults to the most
   *  recently created container). */
  triggerExit(containerId = `container-${this.createdSpecs.length}`): void {
    this.exitResolvers.get(containerId)?.();
    this.exitResolvers.delete(containerId);
  }

  async pullImage(image: string) {
    this.pulled.push(image);
  }
  async createContainer(spec: Record<string, unknown>) {
    if (this.failCreateOnce) {
      this.failCreateOnce = false;
      throw new Error("docker: create failed (transient)");
    }
    this.createdSpecs.push(spec);
    return `container-${this.createdSpecs.length}`;
  }
  async start(id: string) {
    this.started.push(id);
    // Real Docker streams logs asynchronously, and the service attaches its
    // follower AFTER start() returns — replay on a later tick or the ready
    // marker would be emitted into the void.
    setTimeout(() => {
      for (const line of this.logScript) for (const h of this.lineHandlers.values()) h(line);
    }, 0);
  }
  async stop(id: string) {
    this.stopped.push(id);
    if (this.hangStop) return new Promise<void>(() => undefined); // never resolves
  }
  async remove(id: string) {
    this.removed.push(id);
  }
  async removeByServerId(id?: string) {
    this.removedByServerId.push(id);
  }
  async tailLogs() {
    return "";
  }
  async followLogs(containerId: string, onLine: (line: string) => void) {
    this.lineHandlers.set(containerId, onLine);
    return () => this.lineHandlers.delete(containerId);
  }
  async inspect() {
    return {};
  }
  async listManagedServers() {
    return [];
  }
}

/** Minimal in-memory Prisma for the rows ServersService touches on start. */
export function makePrisma(row: ServerRow) {
  return {
    row,
    server: {
      findUnique: async () => row,
      findMany: async () => [row],
      update: async ({ data }: { data: Partial<ServerRow> }) => Object.assign(row, data),
      count: async () => 1,
    },
    modInstall: { findMany: async () => [] },
    snapshot: { findMany: async () => [] },
  };
}

const noop = async () => undefined;

export async function makeService(row: ServerRow, docker: FakeDocker) {
  const { ServersService } = await import("./servers.service");
  const { StateMachineService } = await import("./state-machine.service");
  const { CatalogService } = await import("../catalog/catalog.service");
  const { ServerConfigWriter } = await import("./config-writer.service");

  const prisma = makePrisma(row);
  const crypto = { encrypt: (s: string) => s, decrypt: (s: string) => s };
  const catalog = new CatalogService();
  // The REAL config writer — writeInis is exactly what the fall-through guard tests.
  const configWriter = new ServerConfigWriter(crypto as never, catalog);
  // Recorder so tests can assert notifications (crash, startup-deadline) were emitted.
  const emitted: { type: string; message: string; serverId?: string }[] = [];
  const events = {
    emit: async (e: { type: string; message: string; serverId?: string }) => {
      emitted.push(e);
    },
    onEvent: () => undefined,
  };
  const realtime = { broadcast: () => undefined };
  const sm = new StateMachineService(prisma as never, events as never, realtime as never);
  const logCapture = {
    clear: () => undefined,
    seed: () => undefined,
    recordLog: () => undefined,
    recordConsole: () => undefined,
    getLogs: () => "",
    getConsole: () => "",
    onLine: () => undefined,
  };
  const service = new ServersService(
    prisma as never,
    crypto as never,
    events as never,
    realtime as never,
    docker as never,
    catalog,
    { prepareGameFiles: noop, seedGameFilesCache: noop } as never,
    { disconnect: noop, saveWorld: noop, broadcast: noop } as never,
    sm,
    { getTimezone: async () => "UTC", get: async () => null, getBackupKeep: async () => 10 } as never,
    logCapture as never,
    { create: noop } as never,
    { count: async () => ({ online: 0 }) } as never,
    configWriter,
    { getAll: async () => ({}) } as never, // artwork
  );
  return { service, prisma, sm, events, emitted };
}

/** Start bypassing the RAM guard + port check (host-dependent, not what we test). */
export async function startServer(service: unknown, id: string) {
  const svc = service as unknown as Record<string, unknown>;
  svc.assertPortsFree = async () => undefined;
  await (svc.doStart as (id: string) => Promise<void>).call(svc, id);
}

/** Neuter both start-time guards on the instance so the crash-watchdog's own call
 *  to the guarded start() (auto-restart) doesn't consult host RAM/ports. */
export function neuterGuards(service: unknown): void {
  const svc = service as unknown as Record<string, unknown>;
  svc.assertPortsFree = async () => undefined;
  svc.assertRamAvailable = async () => undefined;
}
