import { describe, it, expect, vi } from "vitest";
import { EventType, Game, ServerState } from "@ark/shared";
import { SightingsService } from "./sightings.service";

/**
 * Enshrouded has no console, so presence comes from the server log alone: a
 * "logged in" line puts the name on the roster, each poll pass counts a minute
 * for everyone on it (which is what keeps them Online), and the "Remove Entity"
 * line takes them off again.
 */
function makeSvc() {
  const prisma = {
    server: {
      findMany: vi.fn(async () => [{ id: "s1", game: Game.ENSHROUDED, state: ServerState.Running }]),
    },
    playerSighting: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  };
  const events = { emit: vi.fn(async () => undefined) };
  let onLine: (serverId: string, line: string) => void = () => undefined;
  const logCapture = { onLine: (cb: typeof onLine) => (onLine = cb) };
  const svc = new SightingsService(
    prisma as never,
    {} as never,
    logCapture as never,
    {} as never,
    events as never,
  );
  svc.onModuleInit();
  const poll = () => (svc as unknown as { poll: () => Promise<void> }).poll();
  return { prisma, events, line: (l: string) => onLine("s1", l), poll };
}

const ticks = (prisma: ReturnType<typeof makeSvc>["prisma"]) =>
  (prisma.playerSighting.upsert.mock.calls as unknown[][]).filter((c) => {
    const arg = c[0] as { update: { minutesPlayed?: unknown } };
    return arg.update.minutesPlayed !== undefined;
  }).length;

describe("Enshrouded presence from the log", () => {
  it("keeps a logged-in player online across polls until the leave line", async () => {
    const { prisma, events, line, poll } = makeSvc();
    await poll(); // loads the game cache
    line("[server] Player 'Alice' logged in with Permissions: 15");
    await vi.waitFor(() => expect(prisma.playerSighting.upsert).toHaveBeenCalled());
    expect(events.emit).toHaveBeenCalledWith(expect.objectContaining({ type: EventType.PlayerJoin }));

    await poll();
    await poll();
    expect(ticks(prisma)).toBe(2);

    line("[server] Remove Entity for Player 'Alice'");
    await vi.waitFor(() =>
      expect(events.emit).toHaveBeenCalledWith(expect.objectContaining({ type: EventType.PlayerLeave })),
    );
    await poll();
    expect(ticks(prisma)).toBe(2);
  });

  it("ignores the machine-handle login line and a leave for an unknown name", async () => {
    const { prisma, events, line, poll } = makeSvc();
    await poll();
    line("[server] Machine '1': Player '0(0)' logged in");
    line("[server] Remove Entity for Player 'Ghost'");
    await new Promise((r) => setTimeout(r, 20));
    expect(prisma.playerSighting.upsert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
