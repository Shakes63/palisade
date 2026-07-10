import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game, ServerState } from "@ark/shared";
import { ServersService } from "./servers.service";

// Reconcile decision logic with stubbed deps. We assert how DB state + monitors
// are snapped to the observed Docker reality after a (simulated) manager restart.

type Row = { id: string; name: string; game?: Game; state: ServerState; containerId: string | null };

function makeService(rows: Row[], containers: Array<{ id: string; serverId: string; running: boolean; status: string }>, logs: Record<string, string> = {}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const forced: Array<{ id: string; to: ServerState; reason: string }> = [];
  const removed: string[] = [];
  const attached: string[] = [];

  const prisma = {
    server: {
      findMany: vi.fn(async () => rows),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return {};
      }),
    },
  };
  const docker = {
    listManagedServers: vi.fn(async () => containers),
    remove: vi.fn(async (id: string) => {
      removed.push(id);
    }),
    tailLogs: vi.fn(async (id: string) => logs[id] ?? ""),
    followLogs: vi.fn(async () => () => undefined),
    client: { getContainer: () => ({ wait: () => new Promise(() => undefined) }) },
  };
  const sm = {
    force: vi.fn(async (id: string, to: ServerState, reason: string) => {
      forced.push({ id, to, reason });
      // keep rows coherent for any follow-on reads
      const r = rows.find((x) => x.id === id);
      if (r) r.state = to;
    }),
  };

  const svc = new ServersService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    docker as never,
    {} as never,
    {} as never,
    {} as never,
    sm as never,
    {} as never,
    {} as never, // logCapture
    {} as never, // backups
    { cached: () => null, count: async () => null } as never, // players
    { writeInis: async () => undefined } as never, // configWriter
  );
  // attachMonitors is private; spy via prototype to record adoption without real IO.
  vi.spyOn(svc as unknown as { attachMonitors: (a: string, b: string) => Promise<void> }, "attachMonitors").mockImplementation(
    async (id: string) => {
      attached.push(id);
    },
  );
  return { svc, updates, forced, removed, attached };
}

describe("reconcile()", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("adopts a running container that finished booting (Starting→Running via logs)", async () => {
    const { svc, forced, attached } = makeService(
      [{ id: "s1", name: "A", game: Game.ASA, state: ServerState.Starting, containerId: "old" }],
      [{ id: "c1", serverId: "s1", running: true, status: "Up 2h" }],
      { c1: "Server has completed startup and is now advertising for join. (10.2GB Mem)" },
    );
    await svc.reconcile();
    expect(forced).toEqual([{ id: "s1", to: ServerState.Running, reason: expect.any(String) }]);
    expect(attached).toContain("s1");
  });

  it("keeps Starting when a running container is still booting (no ready marker)", async () => {
    const { svc, forced, attached } = makeService(
      [{ id: "s1", name: "A", game: Game.ASA, state: ServerState.Starting, containerId: "c1" }],
      [{ id: "c1", serverId: "s1", running: true, status: "Up 1m" }],
      { c1: "Proton: Upgrading prefix ..." },
    );
    await svc.reconcile();
    expect(forced).toHaveLength(0); // already Starting → no state change
    expect(attached).toContain("s1");
  });

  it("adopts a running container the DB wrongly thinks is Stopped", async () => {
    const { svc, forced, attached } = makeService(
      [{ id: "s1", name: "A", state: ServerState.Stopped, containerId: null }],
      [{ id: "c1", serverId: "s1", running: true, status: "Up 5m" }],
    );
    await svc.reconcile();
    expect(forced).toEqual([{ id: "s1", to: ServerState.Running, reason: expect.any(String) }]);
    expect(attached).toContain("s1");
  });

  it("resumes an interrupted stop (Stopping + still-running container), not adopt as Running", async () => {
    const { svc, forced, attached } = makeService(
      [{ id: "s1", name: "A", state: ServerState.Stopping, containerId: "c1" }],
      [{ id: "c1", serverId: "s1", running: true, status: "Up 9m" }],
    );
    const teardown = vi
      .spyOn(
        svc as unknown as { tearDownStopped: (a: string, b: string) => Promise<void> },
        "tearDownStopped",
      )
      .mockResolvedValue(undefined);
    await svc.reconcile();
    expect(teardown).toHaveBeenCalledWith("s1", "c1"); // finishes the stop
    expect(forced).toHaveLength(0); // NOT flipped back to Running
    expect(attached).toHaveLength(0); // NOT re-adopted
  });

  it("settles a Stopping server whose container exited to Stopped (not Crashed)", async () => {
    const { svc, forced, removed } = makeService(
      [{ id: "s1", name: "A", state: ServerState.Stopping, containerId: "c1" }],
      [{ id: "c1", serverId: "s1", running: false, status: "Exited (143) 1m ago" }],
    );
    await svc.reconcile();
    expect(forced).toEqual([{ id: "s1", to: ServerState.Stopped, reason: expect.any(String) }]);
    expect(removed).toContain("c1"); // stale container cleaned up
  });

  it("marks a Running server Crashed when its container exited while we were down", async () => {
    const { svc, forced, removed } = makeService(
      [{ id: "s1", name: "A", state: ServerState.Running, containerId: "c1" }],
      [{ id: "c1", serverId: "s1", running: false, status: "Exited (1) 3m ago" }],
    );
    await svc.reconcile();
    expect(forced).toEqual([{ id: "s1", to: ServerState.Crashed, reason: expect.any(String) }]);
    expect(removed).toContain("c1"); // stale container cleaned up
  });

  it("marks a Running server Stopped when no container exists at all", async () => {
    const { svc, forced } = makeService(
      [{ id: "s1", name: "A", state: ServerState.Running, containerId: "gone" }],
      [],
    );
    await svc.reconcile();
    expect(forced).toEqual([{ id: "s1", to: ServerState.Stopped, reason: expect.any(String) }]);
  });

  it("leaves a cleanly-Stopped server alone", async () => {
    const { svc, forced, attached } = makeService(
      [{ id: "s1", name: "A", state: ServerState.Stopped, containerId: null }],
      [],
    );
    await svc.reconcile();
    expect(forced).toHaveLength(0);
    expect(attached).toHaveLength(0);
  });
});
