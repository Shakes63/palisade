import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { join } from "node:path";
import { Game, ServerState } from "@ark/shared";
import { FakeDocker, makeRow, makeService, setupE2eEnv, startServer } from "./lifecycle-harness";

/**
 * Lifecycle E2E: drives the real ServersService (real state machine, real
 * spec builder, real config writers) against a scripted fake Docker daemon and
 * an in-memory Prisma. Catches wiring regressions the per-game unit tests
 * can't — e.g. the writeInis fall-through that silently rendered ARK INIs into
 * Core Keeper and Rust instance dirs. Fault-injection lives in chaos.e2e.test.ts.
 */

beforeAll(setupE2eEnv);

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
      // ASA + Conan (POK images) sudo in their entrypoints → no-new-privileges
      // would crash them, so they're exempt; every other game gets it.
      const nnp = (spec.HostConfig.SecurityOpt ?? []).includes("no-new-privileges:true");
      expect(nnp, game).toBe(!(game === Game.ASA || game === Game.CONAN));
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

// A restart reclaims the memory it just freed, so the RAM guard must not gate the
// way back up. Regression: restart() called start() unguarded, so on a box with
// less free RAM than the server's ramLimitMb (a CAP, not real usage) the stop
// succeeded and the start was refused — leaving the server down. Live-reproduced
// on Palworld: needMb 12288 vs availableMb 11119, actual usage 825 MB.
describe("restart", () => {
  it("bypasses the RAM guard on the way back up (but not the port check)", async () => {
    const row = makeRow({ state: ServerState.Running, ramLimitMb: 12288 });
    const docker = new FakeDocker();
    const { service } = await makeService(row, docker);
    const svc = service as unknown as Record<string, unknown>;

    let ramGuardCalls = 0;
    let portCheckCalls = 0;
    svc.assertRamAvailable = async () => {
      ramGuardCalls++;
      throw new Error("INSUFFICIENT_RAM");
    };
    svc.assertPortsFree = async () => {
      portCheckCalls++;
    };
    svc.stop = async () => {
      row.state = ServerState.Stopped;
    };

    await (svc.restart as (id: string) => Promise<void>).call(svc, row.id);

    expect(ramGuardCalls, "restart must not consult the RAM guard").toBe(0);
    expect(portCheckCalls, "restart must still check ports").toBe(1);
    expect(docker.started).toEqual(["container-1"]);
  });
});
