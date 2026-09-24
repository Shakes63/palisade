import { describe, it, expect, vi } from "vitest";
import { EventType, Game, ServerState } from "@ark/shared";
import { SightingsService } from "./sightings.service";

/**
 * Enshrouded has no console, so presence comes from the server log alone: a
 * "logged in" line puts the name on the roster, each poll pass counts a minute
 * for everyone on it (which is what keeps them Online), and the "Remove Entity"
 * line takes them off again.
 */
function makeSvc(game = Game.ENSHROUDED) {
  const prisma = {
    server: {
      findMany: vi.fn(async () => [{ id: "s1", game, state: ServerState.Running }]),
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
  return { svc, prisma, events, line: (l: string) => onLine("s1", l), poll };
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

/** Lines verbatim from a lloesche/valheim-server 1.0.15 boot, Steam then crossplay. */
describe("Valheim presence from the log", () => {
  const upserted = (prisma: ReturnType<typeof makeSvc>["prisma"]) =>
    (prisma.playerSighting.upsert.mock.calls as unknown[][]).map((c) => (c[0] as { create: unknown }).create);

  it("tracks a Steam player with a spaced name from join to leave", async () => {
    const { svc, prisma, events, line, poll } = makeSvc(Game.VALHEIM);
    await poll();
    line("09/24/2026 08:14:47: Got handshake from client 76561198051014133");
    line("09/24/2026 08:15:37: Got character ZDOID from Palisade Tester : 1305773203:5");
    await vi.waitFor(() =>
      expect(upserted(prisma)).toContainEqual({ serverId: "s1", name: "Palisade Tester", playerId: "76561198051014133" }),
    );
    expect(svc.logRosterCount("s1")).toBe(1);

    await poll();
    expect(ticks(prisma)).toBe(1);

    line("09/24/2026 08:18:38: Destroying abandoned non persistent zdo 1305773203:5 owner 1305773203");
    line("09/24/2026 08:18:38: Destroying abandoned non persistent zdo 1305773203:116 owner 1305773203");
    await vi.waitFor(() =>
      expect(events.emit).toHaveBeenCalledWith(expect.objectContaining({ type: EventType.PlayerLeave })),
    );
    const leaves = (events.emit.mock.calls as unknown[][]).filter(
      (c) => (c[0] as { type: EventType }).type === EventType.PlayerLeave,
    );
    expect(leaves).toHaveLength(1);
    expect(svc.logRosterCount("s1")).toBe(0);
    await poll();
    expect(ticks(prisma)).toBe(1);
  });

  it("takes the SteamID from the crossplay platform line", async () => {
    const { prisma, line, poll } = makeSvc(Game.VALHEIM);
    await poll();
    line("PlayFab socket with remote ID playfab/D3E2D552844E42EA received local Platform ID Steam_76561198051014133");
    line("Got handshake from client playfab/D3E2D552844E42EA");
    line("Got character ZDOID from Justin : -1284701504:1");
    await vi.waitFor(() =>
      expect(upserted(prisma)).toContainEqual({ serverId: "s1", name: "Justin", playerId: "76561198051014133" }),
    );
  });

  it("ignores a death respawn and forgets everyone when the server process restarts", async () => {
    const { svc, prisma, line, poll } = makeSvc(Game.VALHEIM);
    await poll();
    line("Got character ZDOID from Justin : 42:1");
    line("Got character ZDOID from Justin : 0:0");
    await new Promise((r) => setTimeout(r, 20));
    expect(prisma.playerSighting.upsert).toHaveBeenCalledTimes(1);
    expect(svc.logRosterCount("s1")).toBe(1);
    line("09/24/2026 08:28:47: Game server connected");
    expect(svc.logRosterCount("s1")).toBe(0);
  });
});

describe("players view", () => {
  const view = (game: Game, state = ServerState.Running) => {
    const prisma = {
      server: { findUnique: vi.fn(async () => ({ id: "s1", game, state })) },
      playerSighting: { findMany: vi.fn(async () => []) },
    };
    const svc = new SightingsService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    return svc.view("s1");
  };

  it("says plainly when a game records no players", async () => {
    for (const game of [Game.OPENTTD, Game.CS2, Game.VRISING, Game.SATISFACTORY, Game.DST, Game.CORE_KEEPER]) {
      const v = await view(game);
      expect(v.tracked).toBe(false);
      expect(v.captureNote).toMatch(/isn't available/);
    }
    for (const game of [Game.ASA, Game.MINECRAFT, Game.VALHEIM, Game.ENSHROUDED, Game.SEVEN_DAYS]) {
      expect((await view(game)).tracked).toBe(true);
    }
  });

  it("marks only the console-driven actions as needing a running server", async () => {
    expect((await view(Game.MINECRAFT)).liveActions).toEqual(["kick", "ban", "whitelist", "admin"]);
    expect((await view(Game.VALHEIM)).liveActions).toEqual([]);
    expect((await view(Game.SEVEN_DAYS)).liveActions).toEqual(["kick"]);
    expect((await view(Game.ASA, ServerState.Stopped)).running).toBe(false);
  });
});
