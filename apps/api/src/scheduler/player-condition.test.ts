import { describe, it, expect, vi } from "vitest";
import { ServerState } from "@ark/shared";
import { SchedulerService } from "./scheduler.service";

/**
 * Player-count conditions on a schedule (GH #97). A firing runs only while the
 * online count sits inside the bounds, whatever the action — this generalizes the
 * old `skipIfPlayersOnline` flag, which was "at most 0" for disruptive actions.
 * An unreadable count (null) must never block a firing, or an unreachable query
 * port would leave the schedule dead.
 */

function makeScheduler(
  sched: {
    action: string;
    minPlayersOnline?: number | null;
    maxPlayersOnline?: number | null;
    command?: string | null;
  },
  online: number | null,
) {
  const prisma = {
    schedule: {
      findUnique: vi.fn(async () => ({
        id: "sch-1",
        serverId: "srv-1",
        name: "test",
        enabled: true,
        // 0 so a disruptive action's countdown doesn't sleep a real minute per step.
        warnMinutes: 0,
        command: null,
        minPlayersOnline: null,
        maxPlayersOnline: null,
        runAt: null,
        ...sched,
      })),
      update: vi.fn(async () => undefined),
    },
    server: { findUnique: vi.fn(async () => ({ state: ServerState.Running })) },
  };
  const events = { emit: vi.fn(async () => undefined) };
  const rcon = { broadcast: vi.fn(async () => "ok"), exec: vi.fn(async () => "ok") };
  const backups = { create: vi.fn(async () => undefined) };
  const servers = { restart: vi.fn(), stop: vi.fn(), start: vi.fn(), updateGame: vi.fn() };
  const players = { count: vi.fn(async () => (online === null ? null : { online })) };
  const svc = new SchedulerService(
    prisma as never,
    events as never,
    servers as never,
    rcon as never,
    backups as never,
    {} as never,
    players as never,
    {} as never,
    {} as never,
  );
  // fire() is private; the cron callback is the only production caller.
  const fire = (svc as unknown as { fire(id: string): Promise<void> }).fire.bind(svc);
  return { fire, events, rcon, servers, players };
}

const messages = (events: { emit: ReturnType<typeof vi.fn> }) =>
  events.emit.mock.calls.map((c) => (c[0] as { message: string }).message).join("\n");

describe("schedule player-count conditions (GH #97)", () => {
  it("runs when the count meets an at-least bound", async () => {
    const { fire, rcon } = makeScheduler(
      { action: "announce", command: "Raid night!", minPlayersOnline: 10 },
      12,
    );
    await fire("sch-1");
    expect(rcon.broadcast).toHaveBeenCalledWith("srv-1", "Raid night!");
  });

  it("skips below an at-least bound, saying what it was waiting for", async () => {
    const { fire, rcon, events } = makeScheduler(
      { action: "announce", command: "Raid night!", minPlayersOnline: 10 },
      4,
    );
    await fire("sch-1");
    expect(rcon.broadcast).not.toHaveBeenCalled();
    expect(messages(events)).toContain(
      "skipped — 4 players online, but it only runs when at least 10 players are online",
    );
  });

  it("skips above an at-most bound and runs at or under it", async () => {
    const busy = makeScheduler({ action: "restart", maxPlayersOnline: 3 }, 5);
    await busy.fire("sch-1");
    expect(busy.servers.restart).not.toHaveBeenCalled();
    expect(messages(busy.events)).toContain("only runs when at most 3 players are online");

    const quiet = makeScheduler({ action: "restart", maxPlayersOnline: 3 }, 3);
    await quiet.fire("sch-1");
    expect(quiet.servers.restart).toHaveBeenCalledWith("srv-1");
  });

  it("keeps the verb agreeing with a threshold of one", async () => {
    const { fire, events, rcon } = makeScheduler(
      { action: "announce", command: "Raid night!", minPlayersOnline: 1 },
      0,
    );
    await fire("sch-1");
    expect(rcon.broadcast).not.toHaveBeenCalled();
    expect(messages(events)).toContain("it only runs when at least 1 player is online");
  });

  it("carries the old skip-while-players-online behaviour as at most 0", async () => {
    const busy = makeScheduler({ action: "restart", maxPlayersOnline: 0 }, 1);
    await busy.fire("sch-1");
    expect(busy.servers.restart).not.toHaveBeenCalled();
    expect(messages(busy.events)).toContain(
      "skipped — 1 player online, but it only runs when nobody is online",
    );

    const empty = makeScheduler({ action: "restart", maxPlayersOnline: 0 }, 0);
    await empty.fire("sch-1");
    expect(empty.servers.restart).toHaveBeenCalledWith("srv-1");
  });

  it("runs anyway when the count can't be read, rather than going dead", async () => {
    const { fire, servers, events } = makeScheduler(
      { action: "restart", maxPlayersOnline: 0 },
      null,
    );
    await fire("sch-1");
    expect(servers.restart).toHaveBeenCalledWith("srv-1");
    expect(messages(events)).not.toContain("skipped");
  });

  it("leaves a schedule with no condition alone, however busy the server is", async () => {
    const { fire, servers, players } = makeScheduler({ action: "restart" }, 40);
    await fire("sch-1");
    expect(servers.restart).toHaveBeenCalledWith("srv-1");
    // No bounds to check, so the count is never even queried.
    expect(players.count).not.toHaveBeenCalled();
  });
});
