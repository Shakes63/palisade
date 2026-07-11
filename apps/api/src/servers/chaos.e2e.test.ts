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
});
