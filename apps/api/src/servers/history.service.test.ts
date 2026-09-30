import { afterEach, describe, it, expect, vi } from "vitest";
import { MAX_CONDITION_HELD_MINUTES, ServerState } from "@ark/shared";
import { HistoryService, playerCountHeld, type HistorySample } from "./history.service";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const empty = (online: number) => online === 0;
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);
const UP_AN_HOUR = minutesAgo(60);

/** One sample every 30 s, oldest first, the last one at NOW. */
function series(counts: (number | null)[], stepMs = 30_000): HistorySample[] {
  return counts.map((playersOnline, i) => ({
    at: new Date(NOW - (counts.length - 1 - i) * stepMs).toISOString(),
    cpuPercent: null,
    memUsedMb: null,
    playersOnline,
  }));
}

describe("playerCountHeld", () => {
  it("holds when every readable sample across the window satisfies it", () => {
    expect(playerCountHeld(series(Array(25).fill(0)), 10, empty, UP_AN_HOUR, NOW)).toBe(true);
  });

  it("fails when a player was online inside the window", () => {
    const counts = Array(25).fill(0);
    counts[20] = 1;
    expect(playerCountHeld(series(counts), 10, empty, UP_AN_HOUR, NOW)).toBe(false);
  });

  it("ignores a player who left before the window began", () => {
    const counts = Array(25).fill(0);
    counts[0] = 3;
    expect(playerCountHeld(series(counts), 10, empty, UP_AN_HOUR, NOW)).toBe(true);
  });

  it("fails for a server that only just came up", () => {
    expect(playerCountHeld(series([0, 0]), 10, empty, minutesAgo(1), NOW)).toBe(false);
  });

  it("fails when the server isn't running", () => {
    expect(playerCountHeld(series(Array(25).fill(0)), 10, empty, null, NOW)).toBe(false);
  });

  it("never spans a restart, however seamless the history looks", () => {
    // A stop and start inside one sampling gap leaves no trace in the samples.
    expect(playerCountHeld(series(Array(25).fill(0)), 10, empty, minutesAgo(0.25), NOW)).toBe(false);
  });

  it("judges a game that reports no players on its uptime alone", () => {
    expect(playerCountHeld(series(Array(25).fill(null)), 10, empty, UP_AN_HOUR, NOW)).toBe(true);
    expect(playerCountHeld(series(Array(25).fill(null)), 10, empty, minutesAgo(5), NOW)).toBe(false);
  });

  it("tolerates a dropped query inside a covered window", () => {
    const counts = Array(25).fill(0);
    counts[12] = null;
    expect(playerCountHeld(series(counts), 10, empty, UP_AN_HOUR, NOW)).toBe(true);
  });

  it("fails across a gap in the history, where the manager wasn't watching", () => {
    const before = series(Array(10).fill(0)).map((s) => ({
      ...s,
      at: new Date(Date.parse(s.at) - 10 * 60_000).toISOString(),
    }));
    expect(playerCountHeld([...before, ...series([0, 0, 0])], 10, empty, UP_AN_HOUR, NOW)).toBe(false);
  });

  it("fails without the history to show it, as after a manager restart", () => {
    expect(playerCountHeld([], 10, empty, UP_AN_HOUR, NOW)).toBe(false);
  });

  it("fails when the newest sample is stale", () => {
    const stale = series(Array(25).fill(0));
    expect(playerCountHeld(stale, 10, empty, UP_AN_HOUR, NOW + 5 * 60_000)).toBe(false);
  });
});

describe("HistoryService sampling", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps enough history for the longest held condition a schedule may ask for", async () => {
    vi.useFakeTimers({ now: NOW });
    const prisma = {
      server: { findMany: vi.fn(async () => [{ id: "srv-1", containerId: null, state: ServerState.Running }]) },
    };
    const players = { count: vi.fn(async () => ({ online: 0 })) };
    const history = new HistoryService(prisma as never, {} as never, players as never);
    // sample() is private; the 30 s interval is its only production caller.
    const sample = (history as unknown as { sample(): Promise<void> }).sample.bind(history);
    for (let i = 0; i < 3 * MAX_CONDITION_HELD_MINUTES; i++) {
      await sample();
      vi.advanceTimersByTime(30_000);
    }
    vi.setSystemTime(Date.now() - 30_000);
    expect(history.playerCountHeld("srv-1", MAX_CONDITION_HELD_MINUTES, empty, new Date(NOW))).toBe(true);
  });
});
