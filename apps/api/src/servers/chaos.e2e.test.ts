import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Game, ServerState } from "@ark/shared";
import { FakeDocker, makeRow, makeService, neuterGuards, setupE2eEnv, startServer } from "./lifecycle-harness";

/**
 * Chaos E2E: injects the failure modes we've actually hit in production and
 * asserts the manager SELF-HEALS instead of wedging. This is the reliability
 * regression guard — recovery behaviour (auto-restart, crash-loop cap, the
 * startup deadline, bounded teardown) is proven, not assumed, for every future
 * change. Built on the same real-service/fake-Docker harness as the wiring suite.
 */

beforeAll(setupE2eEnv);

const MINECRAFT_READY = '[Server thread/INFO]: Done (8.488s)! For help, type "help"';
/** Flush the fake-Docker log replay + the service's async onReady/onExit chains. */
const tick = () => new Promise((r) => setTimeout(r, 25));

describe("chaos: startup deadline", () => {
  let docker: FakeDocker;
  beforeEach(() => {
    docker = new FakeDocker();
  });

  it("fails a start that never reaches ready, tears it down, and frees the slot", async () => {
    vi.useFakeTimers();
    try {
      const row = makeRow({ game: Game.MINECRAFT, id: "chaos-stuck", map: "world" });
      docker.logScript = ["[Server thread/INFO]: Preparing level (no ready marker follows)"];
      const { service, emitted } = await makeService(row, docker);
      await startServer(service, row.id);

      await vi.advanceTimersByTimeAsync(1); // flush the log replay
      expect(row.state, "healthy-looking boot with no marker sits in Starting").toBe(ServerState.Starting);

      // Advance past Minecraft's 30-min default deadline.
      await vi.advanceTimersByTimeAsync(31 * 60_000);

      expect(row.state, "a wedged start must fail, not hang forever").toBe(ServerState.Crashed);
      expect(row.containerId, "the container link is cleared so the slot frees").toBeNull();
      // The "never became ready" notice is emitted ONLY by the deadline path — the
      // unambiguous proof the failsafe (not some other teardown) fired.
      expect(emitted.some((e) => /never became ready/i.test(e.message)), "the user is notified").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT fire once the server reaches Running in time", async () => {
    vi.useFakeTimers();
    try {
      const row = makeRow({ game: Game.MINECRAFT, id: "chaos-ok", map: "world" });
      docker.logScript = [MINECRAFT_READY];
      const { service, emitted } = await makeService(row, docker);
      await startServer(service, row.id);

      await vi.advanceTimersByTimeAsync(1); // marker fires → Running
      expect(row.state).toBe(ServerState.Running);

      // Long past any deadline: a Running server must be untouched and un-notified.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(row.state).toBe(ServerState.Running);
      expect(emitted.some((e) => /never became ready/i.test(e.message)), "no false deadline notice").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("chaos: crash recovery", () => {
  let docker: FakeDocker;
  beforeEach(() => {
    docker = new FakeDocker();
  });

  it("auto-restarts a Running server that exits unexpectedly", async () => {
    const row = makeRow({ game: Game.MINECRAFT, id: "chaos-crash", map: "world" });
    docker.logScript = [MINECRAFT_READY];
    const { service } = await makeService(row, docker);
    neuterGuards(service); // the watchdog's auto-restart calls the guarded start()
    await startServer(service, row.id);
    await tick();
    expect(row.state).toBe(ServerState.Running);

    docker.triggerExit("container-1"); // the container process dies
    await tick();

    expect(docker.started.length, "the watchdog restarted it").toBeGreaterThanOrEqual(2);
    expect(row.state, "it's back up (re-reaches the ready marker)").toBe(ServerState.Running);
  });

  it("stops auto-restarting after the crash-loop limit and notifies", async () => {
    const row = makeRow({ game: Game.MINECRAFT, id: "chaos-loop", map: "world" });
    docker.logScript = [MINECRAFT_READY];
    const { service, emitted } = await makeService(row, docker);
    neuterGuards(service);
    await startServer(service, row.id);
    await tick();

    // Kill it repeatedly. CRASH_LIMIT is 3 within a 5-min window; the 3rd exit
    // trips the loop guard and auto-restart pauses.
    for (let i = 1; i <= 3; i++) {
      docker.triggerExit(`container-${i}`);
      await tick();
    }

    expect(row.state, "crash-looping server is parked in Crashed, not restarted forever").toBe(
      ServerState.Crashed,
    );
    expect(docker.started.length, "restarts stop at the limit (initial + 2 retries)").toBe(3);
    expect(emitted.some((e) => /loop guard|auto-restart paused/i.test(e.message)), "loop-guard notice sent").toBe(
      true,
    );
  });

  it("captures the container's exit reason (code + log tail) onto the crashed server", async () => {
    const row = makeRow({ game: Game.MINECRAFT, id: "chaos-reason", map: "world" });
    docker.logScript = [MINECRAFT_READY];
    // What inspect()/tailLogs() will report when the container dies.
    docker.exitCode = 1;
    docker.crashLogTail =
      "[init] Starting the Minecraft server...\n" +
      "Error: UnsupportedClassVersionError: class file version 69.0 > 65.0";
    const { service } = await makeService(row, docker);
    neuterGuards(service);
    await startServer(service, row.id);
    await tick();

    // Crash it past the loop limit so it parks in Crashed (no restart clears the reason).
    for (let i = 1; i <= 3; i++) {
      docker.triggerExit(`container-${i}`);
      await tick();
    }

    expect(row.state).toBe(ServerState.Crashed);
    expect(row.crashReason, "the exit code is captured").toMatch(/exited with code 1/);
    expect(row.crashReason, "the log tail is captured for the UI").toMatch(/UnsupportedClassVersionError/);
    // And a clean restart wipes the stale reason.
    docker.exitCode = 0;
    await startServer(service, row.id);
    await tick();
    expect(row.state, "reached ready again").toBe(ServerState.Running);
    expect(row.crashReason, "stale reason cleared on a fresh start").toBeNull();
  });
});

describe("chaos: bounded teardown + start failure", () => {
  let docker: FakeDocker;
  beforeEach(() => {
    docker = new FakeDocker();
  });

  it("force-removes and settles to Stopped even when docker.stop hangs", async () => {
    vi.useFakeTimers();
    try {
      const row = makeRow({
        game: Game.MINECRAFT,
        id: "chaos-hang",
        map: "world",
        state: ServerState.Running,
        containerId: "container-1",
      });
      docker.hangStop = true; // docker stop never returns
      const { service } = await makeService(row, docker);

      await (service as unknown as { stop: (id: string) => Promise<void> }).stop(row.id);
      // Teardown runs in the background; advance past the 30s stop timeout.
      await vi.advanceTimersByTimeAsync(31_000);

      expect(row.state, "a hung docker stop can't wedge us in Stopping").toBe(ServerState.Stopped);
      expect(docker.removedByServerId, "force-remove guarantees the container is gone").toContain("chaos-hang");
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles to Crashed (not a stuck state) when creating the container fails", async () => {
    const row = makeRow({ game: Game.MINECRAFT, id: "chaos-create", map: "world" });
    docker.failCreateOnce = true;
    const { service } = await makeService(row, docker);

    await expect(startServer(service, row.id)).rejects.toThrow(/Start failed/);
    expect(row.state, "a failed create leaves a clean Crashed, restartable state").toBe(ServerState.Crashed);
    expect(docker.started, "nothing was started").toEqual([]);
  });

  it("fails fast with a clear reason when the game image isn't available", async () => {
    const row = makeRow({ game: Game.MINECRAFT, id: "chaos-noimage", map: "world" });
    docker.missingImage = true; // pull produced nothing and it's not cached
    const { service } = await makeService(row, docker);

    await expect(startServer(service, row.id)).rejects.toThrow(/isn't available/i);
    expect(row.state, "clean Crashed, not a cryptic mid-create failure").toBe(ServerState.Crashed);
    expect(docker.started, "we never tried to start a container without an image").toEqual([]);
  });
});

describe("preflight: disk space", () => {
  // assertDiskAvailable is host-dependent (reads the data volume), so drive it directly
  // with the disk read + install-state stubbed — no real filesystem involved.
  const withStubs = async (game: Game, opts: { cold: boolean; freeMb: number }) => {
    const row = makeRow({ game, id: `disk-${game}`, map: "map" });
    const { service } = await makeService(row, new FakeDocker());
    const svc = service as unknown as Record<string, unknown>;
    svc.isColdInstall = async () => opts.cold;
    svc.sampleFreeDiskMb = async () => opts.freeMb;
    return (svc.assertDiskAvailable as (id: string) => Promise<void>).call(svc, row.id);
  };

  it("rejects a cold start when free disk < install footprint + floor", async () => {
    // 7DTD needs ~18 GB to install; 5 GB free must be refused, clearly.
    await expect(withStubs(Game.SEVEN_DAYS, { cold: true, freeMb: 5000 })).rejects.toThrow(
      /Not enough disk to install/i,
    );
  });

  it("allows a cold start when the volume has ample room", async () => {
    await expect(withStubs(Game.SEVEN_DAYS, { cold: true, freeMb: 60000 })).resolves.toBeUndefined();
  });

  it("a warm restart only needs the runtime floor, not the whole footprint", async () => {
    // Already installed → 3 GB free clears the 2 GB floor even though a fresh 7DTD
    // install would need ~18 GB.
    await expect(withStubs(Game.SEVEN_DAYS, { cold: false, freeMb: 3000 })).resolves.toBeUndefined();
  });

  it("still refuses a warm start when the volume is critically full", async () => {
    await expect(withStubs(Game.SEVEN_DAYS, { cold: false, freeMb: 500 })).rejects.toThrow(
      /Not enough disk to start/i,
    );
  });
});
