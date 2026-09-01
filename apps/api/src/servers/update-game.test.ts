import { describe, it, expect, vi, beforeAll } from "vitest";
import { Game, ServerState } from "@ark/shared";
import { ServersService } from "./servers.service";

/**
 * updateGame() is the "Update game" button. Palisade never runs SteamCMD itself —
 * the image does, at boot — so the contract is: arm the one-shot update flag when
 * this game's image needs asking (ONE_SHOT_UPDATE_ENV: Palworld both variants,
 * Conan), then restart if the server is up, or leave it armed for the next start.
 * runtime-spec turns the flag into the image's update env for that single boot.
 */

beforeAll(() => {
  process.env.DATA_DIR = "/tmp/palisade-update-game-test";
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
});

function makeSvc(row: { id: string; game: Game; state: ServerState }) {
  const prisma = {
    server: {
      findUnique: vi.fn(async () => ({ ...row, name: "Test Server" })),
      update: vi.fn(async () => ({})),
    },
  };
  const events = { emit: vi.fn(async () => undefined) };
  const svc = new ServersService(
    prisma as never,
    {} as never, // crypto
    events as never,
    {} as never, // realtime
    {} as never, // docker
    {} as never, // catalog
    {} as never, // installer
    {} as never, // rcon
    {} as never, // state machine
    {} as never, // manager settings
    {} as never, // logCapture
    {} as never, // backups
    {} as never, // players
    {} as never, // endpoints
    {} as never, // configWriter
    {} as never, // artwork
  );
  // The service restarts DETACHED (a game update is the longest boot there is), so
  // this is the call the assertions below care about.
  const restart = vi.spyOn(svc, "restartDetached").mockResolvedValue(undefined);
  return { svc, restart, prisma, events };
}

/** The flag the next start consumes, or undefined when nothing was armed. */
const armed = (prisma: { server: { update: { mock: { calls: unknown[][] } } } }) =>
  prisma.server.update.mock.calls.map((c) => (c[0] as { data?: { updateRequested?: boolean } }).data);

describe("updateGame()", () => {
  it("arms the one-shot flag and waits for the next start when stopped", async () => {
    const { svc, restart, prisma } = makeSvc({
      id: "pw-stopped",
      game: Game.PALWORLD_WINE,
      state: ServerState.Stopped,
    });

    const res = await svc.updateGame("pw-stopped");

    expect(res.applied).toBe("next-start");
    expect(armed(prisma)).toContainEqual({ updateRequested: true });
    expect(restart).not.toHaveBeenCalled();
  });

  it("records the armed update even though nothing starts yet", async () => {
    // A scheduled update on a stopped server lands here; with no event the schedule
    // fires and leaves nothing behind for whoever set it.
    const { svc, events } = makeSvc({ id: "s1", game: Game.PALWORLD, state: ServerState.Stopped });
    await svc.updateGame("s1");
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/next start/i) }),
    );
  });

  it("restarts a running server so the update happens now", async () => {
    const { svc, restart, prisma } = makeSvc({
      id: "pw-running",
      game: Game.PALWORLD_WINE,
      state: ServerState.Running,
    });

    const res = await svc.updateGame("pw-running");

    expect(res.applied).toBe("restarted");
    expect(armed(prisma)).toContainEqual({ updateRequested: true });
    expect(restart).toHaveBeenCalledWith("pw-running");
  });

  it("arms nothing for images that update on every boot", async () => {
    // ASA (POK) sets UPDATE_SERVER=TRUE — the restart alone is the update, so there
    // is no flag to force and no pointless write.
    const { svc, restart, prisma } = makeSvc({ id: "asa1", game: Game.ASA, state: ServerState.Running });

    const res = await svc.updateGame("asa1");

    expect(res.applied).toBe("restarted");
    expect(armed(prisma)).toEqual([]);
    expect(restart).toHaveBeenCalledWith("asa1");
  });

  it("also arms Palworld native and Conan, whose image updaters the manager disables", async () => {
    for (const game of [Game.PALWORLD, Game.CONAN]) {
      const { svc, prisma } = makeSvc({ id: `s-${game}`, game, state: ServerState.Stopped });
      await svc.updateGame(`s-${game}`);
      expect(armed(prisma)).toContainEqual({ updateRequested: true });
    }
  });

  it("never restarts mid-transition (a stopping server updates on its next start)", async () => {
    const { svc, restart } = makeSvc({
      id: "pw-stopping",
      game: Game.PALWORLD_WINE,
      state: ServerState.Stopping,
    });

    const res = await svc.updateGame("pw-stopping");

    expect(res.applied).toBe("next-start");
    expect(restart).not.toHaveBeenCalled();
  });
});
