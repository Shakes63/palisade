import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game, ServerState } from "@ark/shared";

/**
 * Lifecycle E2E: drives the real ServersService (real state machine, real
 * spec builder, real config writers) against a scripted fake Docker daemon and
 * an in-memory Prisma. Catches wiring regressions the per-game unit tests
 * can't — e.g. the writeInis fall-through that silently rendered ARK INIs into
 * Core Keeper and Rust instance dirs.
 *
 * Deliberately NOT mocked: buildContainerSpec, readiness markers, the state
 * machine's legal-transition table, writeInis. Mocked: Docker, the installer's
 * file-copying, RCON, backups.
 */

beforeAll(async () => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), "palisade-e2e-"));
});

interface ServerRow {
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

function makeRow(over: Partial<ServerRow> = {}): ServerRow {
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

/** Records everything the service asks Docker to do, and replays scripted logs. */
class FakeDocker {
  createdSpecs: Record<string, unknown>[] = [];
  started: string[] = [];
  stopped: string[] = [];
  removed: string[] = [];
  pulled: string[] = [];
  /** Lines fed to the log follower when a container starts. */
  logScript: string[] = [];
  private lineHandlers = new Map<string, (line: string) => void>();

  client = {
    getContainer: () => ({ wait: () => new Promise(() => undefined) }), // never exits
  };

  async pullImage(image: string) {
    this.pulled.push(image);
  }
  async createContainer(spec: Record<string, unknown>) {
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
  }
  async remove(id: string) {
    this.removed.push(id);
  }
  async removeByServerId() {
    /* nothing to remove in the fake */
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
function makePrisma(row: ServerRow) {
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

async function makeService(row: ServerRow, docker: FakeDocker) {
  const { ServersService } = await import("./servers.service");
  const { StateMachineService } = await import("./state-machine.service");
  const { CatalogService } = await import("../catalog/catalog.service");
  const { ServerConfigWriter } = await import("./config-writer.service");

  const prisma = makePrisma(row);
  const crypto = { encrypt: (s: string) => s, decrypt: (s: string) => s };
  const catalog = new CatalogService();
  // The REAL config writer — writeInis is exactly what the fall-through guard tests.
  const configWriter = new ServerConfigWriter(crypto as never, catalog);
  const events = { emit: noop, onEvent: () => undefined };
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
  );
  return { service, prisma, sm };
}

/** Start bypassing the RAM guard + port check (host-dependent, not what we test). */
async function startServer(service: unknown, id: string) {
  const s = service as { doStart: (id: string) => Promise<void>; assertPortsFree: (r: unknown) => Promise<void> };
  const svc = s as unknown as Record<string, unknown>;
  svc.assertPortsFree = async () => undefined;
  await (svc.doStart as (id: string) => Promise<void>).call(svc, id);
}

describe("server lifecycle (fake Docker)", () => {
  let docker: FakeDocker;
  beforeEach(() => {
    docker = new FakeDocker();
  });

  it("start: pulls, creates, starts, and reaches Running on the ready marker", async () => {
    const row = makeRow();
    docker.logScript = [
      "[2026.06.19-23.14.24:284][237]Server has completed startup and is now advertising for join. (10.19GB Mem)",
    ];
    const { service } = await makeService(row, docker);
    await startServer(service, row.id);
    // The marker fires inside start(); give the async onReady a tick to land.
    await new Promise((r) => setTimeout(r, 25));

    expect(docker.pulled).toHaveLength(1);
    expect(docker.createdSpecs).toHaveLength(1);
    expect(docker.started).toEqual(["container-1"]);
    expect(row.containerId).toBe("container-1");
    expect(row.configDirty).toBe(false);
    expect(row.state).toBe(ServerState.Running);
  });

  it("stays Starting when the boot log never prints the ready marker", async () => {
    const row = makeRow();
    docker.logScript = ["[2026.06.19-23.10.00:100][12]Server has successfully started!"]; // early, not ready
    const { service } = await makeService(row, docker);
    await startServer(service, row.id);
    await new Promise((r) => setTimeout(r, 25));
    expect(row.state).toBe(ServerState.Starting);
  });

  it("every game's start assembles a spec with the hardening + its own image", async () => {
    for (const game of Object.values(Game)) {
      const d = new FakeDocker();
      const row = makeRow({ game, map: "map", id: `srv-${game}` });
      const { service } = await makeService(row, d);
      await startServer(service, row.id);
      const spec = d.createdSpecs[0] as {
        Image: string;
        HostConfig: { SecurityOpt: string[]; PidsLimit: number };
      };
      expect(spec.Image, game).toBeTruthy();
      expect(spec.HostConfig.SecurityOpt, game).toContain("no-new-privileges:true");
      expect(spec.HostConfig.PidsLimit, game).toBe(8192);
      expect(d.started, game).toEqual(["container-1"]);
      expect(row.state, game).toBe(ServerState.Starting); // no marker scripted
    }
  });

  it("rejects a start from an illegal state (already Running)", async () => {
    const row = makeRow({ state: ServerState.Running });
    const { service } = await makeService(row, docker);
    await expect(startServer(service, row.id)).rejects.toThrow(/Cannot start from state/);
    expect(docker.createdSpecs).toHaveLength(0);
  });

  // Regression guard for the writeInis fall-through: env-driven games silently
  // reached the final ARK INI renderer and got GameUserSettings.ini/Game.ini
  // written into their instance dirs (hit Core Keeper + Rust for real). Only the
  // three games whose images actually read those INIs may reach that branch —
  // Conan's POK image reads them under server/ShooterGame/Saved/Config/LinuxServer.
  const INI_GAMES = new Set<string>([Game.ASA, Game.ASE, Game.CONAN]);

  it("only ARK-family + Conan write ARK INI files into the instance dir", async () => {
    const { LocalPaths } = await import("../common/paths");
    const { readdir } = await import("node:fs/promises");

    const arkIniFor = async (id: string): Promise<string[]> => {
      const walk = async (dir: string): Promise<string[]> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const found: string[] = [];
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) found.push(...(await walk(full)));
          else if (/^(GameUserSettings|Game)\.ini$/i.test(e.name)) found.push(full);
        }
        return found;
      };
      return walk(LocalPaths.instanceRoot(id));
    };

    for (const game of Object.values(Game)) {
      const d = new FakeDocker();
      const row = makeRow({ game, map: "map", id: `ini-${game}` });
      const { service } = await makeService(row, d);
      await startServer(service, row.id);
      const inis = await arkIniFor(row.id);
      if (INI_GAMES.has(game)) {
        expect(inis.length, `${game} should render ARK INIs`).toBeGreaterThan(0);
      } else {
        expect(inis, `${game} must not render ARK INIs`).toEqual([]);
      }
    }
  });
});
