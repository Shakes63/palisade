import { describe, it, expect, vi } from "vitest";
import { ServerState, canTransition } from "@ark/shared";
import { StateMachineService } from "./state-machine.service";

describe("server state machine", () => {
  it("allows Stopped → Starting → Running", () => {
    expect(canTransition(ServerState.Stopped, ServerState.Starting)).toBe(true);
    expect(canTransition(ServerState.Starting, ServerState.Running)).toBe(true);
  });

  it("rejects Stopped → Running (must go through Starting)", () => {
    expect(canTransition(ServerState.Stopped, ServerState.Running)).toBe(false);
  });

  it("allows recovery from Crashed", () => {
    expect(canTransition(ServerState.Crashed, ServerState.Starting)).toBe(true);
    expect(canTransition(ServerState.Crashed, ServerState.Stopped)).toBe(true);
  });

  it("rejects Running → Updating (must stop first)", () => {
    expect(canTransition(ServerState.Running, ServerState.Updating)).toBe(false);
  });
});

describe("runningSince", () => {
  function makeMachine(state: ServerState) {
    const update = vi.fn(async (_args: { data: { state: string; runningSince: Date | null } }) => undefined);
    const prisma = { server: { findUnique: vi.fn(async () => ({ name: "s", state })), update } };
    const sm = new StateMachineService(
      prisma as never,
      { emit: vi.fn(async () => undefined) } as never,
      { broadcast: vi.fn() } as never,
    );
    return { sm, written: () => update.mock.calls[0]?.[0].data };
  }

  it("stamps the moment a server enters Running, by transition or reconcile", async () => {
    const started = makeMachine(ServerState.Starting);
    await started.sm.transition("srv-1", ServerState.Running);
    expect(started.written()?.runningSince).toBeInstanceOf(Date);

    const adopted = makeMachine(ServerState.Stopped);
    await adopted.sm.force("srv-1", ServerState.Running, "container found running");
    expect(adopted.written()?.runningSince).toBeInstanceOf(Date);
  });

  it("clears it on leaving Running", async () => {
    const { sm, written } = makeMachine(ServerState.Running);
    await sm.transition("srv-1", ServerState.Stopping);
    expect(written()).toEqual({ state: ServerState.Stopping, runningSince: null });
  });
});
