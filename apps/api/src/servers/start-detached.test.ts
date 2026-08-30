import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { FakeDocker, makeRow, makeService, neuterGuards, setupE2eEnv } from "./lifecycle-harness";
import { Game, ServerState } from "@ark/shared";

/**
 * A first start pulls the game image — 3.3 GB for Palworld's Wine variant — which
 * outlives Node's 5-minute default requestTimeout. The socket was torn down mid-pull,
 * the web app's proxy logged ECONNRESET, and the UI reported "Internal Server Error"
 * for a start that was working and did reach Running. Observed on a real box.
 *
 * So the HTTP start now returns once the server is committed to Starting. The point
 * of these is that detaching didn't cost us the thing the request was for: bad input
 * still answers the caller, and a failed launch still lands somewhere the UI reads.
 */
beforeAll(async () => {
  await setupE2eEnv();
});

describe("startDetached", () => {
  let docker: FakeDocker;
  beforeEach(() => {
    docker = new FakeDocker();
  });

  it("returns while the image is still pulling", async () => {
    const row = makeRow();
    const { service } = await makeService(row, docker);
    neuterGuards(service);

    // Hold the pull open, the way a multi-GB first pull does.
    let releasePull!: () => void;
    const pulling = new Promise<void>((res) => (releasePull = res));
    docker.pullImage = async () => {
      await pulling;
    };

    let returned = false;
    const call = service.startDetached(row.id).then(() => (returned = true));
    await call;
    expect(returned).toBe(true);
    // Still mid-pull: the launch has not created anything yet.
    expect(docker.createdSpecs.length).toBe(0);

    releasePull();
  });

  it("commits the server to Starting before it returns", async () => {
    // Otherwise the UI would briefly show Stopped and look like nothing happened.
    const row = makeRow();
    const { service, prisma } = await makeService(row, docker);
    neuterGuards(service);
    let releasePull!: () => void;
    const pulling = new Promise<void>((res) => (releasePull = res));
    docker.pullImage = async () => {
      await pulling;
    };

    await service.startDetached(row.id);
    const after = await prisma.server.findUnique();
    expect(after?.state).toBe(ServerState.Starting);

    releasePull();
  });

  it("still rejects a request that was never valid", async () => {
    // Validation runs before admission, so a bad state is still the caller's answer
    // rather than a silent no-op the UI can't explain.
    const row = makeRow({ state: ServerState.Running });
    const { service } = await makeService(row, docker);
    neuterGuards(service);
    await expect(service.startDetached(row.id)).rejects.toThrow(/Cannot start from state/);
  });

  it("records a launch failure on the server rather than losing it", async () => {
    // The request has already returned by then, so crashReason is the only place
    // left for the reason to surface.
    const row = makeRow();
    const { service, prisma } = await makeService(row, docker);
    neuterGuards(service);
    docker.missingImage = true;

    await service.startDetached(row.id);
    await new Promise((r) => setTimeout(r, 50)); // let the detached launch settle

    const after = await prisma.server.findUnique();
    expect(after?.state).toBe(ServerState.Crashed);
    expect(after?.crashReason).toMatch(/isn't available/);
  });

  it("still rejects a guard that fires before the commit, rather than crashing", async () => {
    // Regression guard for the interaction between #39 and this change: the Wine
    // port check originally sat inside the launch, so detaching turned its 400 into
    // a 201 followed by a Crashed server. Anything that can answer the caller has to
    // run before admission.
    const row = makeRow({ game: Game.PALWORLD_WINE, gamePort: 9000, hostNetwork: true });
    const { service, prisma } = await makeService(row, docker);
    neuterGuards(service);

    await expect(service.startDetached(row.id)).rejects.toThrow(/always listens on 8211/);
    // And it never committed the server, so there is no phantom crash to explain.
    const after = await prisma.server.findUnique();
    expect(after?.state).not.toBe(ServerState.Crashed);
    expect(docker.createdSpecs.length).toBe(0);
  });
});

describe("restartDetached", () => {
  let docker: FakeDocker;
  beforeEach(() => {
    docker = new FakeDocker();
  });

  it("returns immediately, without waiting for the stop", async () => {
    // The whole restart detaches: the API answered a real restart in ~43s, but the
    // web app's proxy severs at ~30s, and the stop alone can spend 30s waiting for a
    // world save. Nothing about a restart fits inside that budget.
    const row = makeRow({ state: ServerState.Running, containerId: "c1" });
    const { service } = await makeService(row, docker);
    neuterGuards(service);

    // A stop that never finishes: returning still has to be immediate.
    (service as unknown as Record<string, unknown>).stop = () => new Promise<void>(() => {});

    await service.restartDetached(row.id);
    expect(docker.createdSpecs.length).toBe(0);
  });

  it("still answers a bad id rather than detaching into nothing", async () => {
    const row = makeRow({ state: ServerState.Running });
    const { service } = await makeService(row, docker);
    neuterGuards(service);
    (service as unknown as Record<string, unknown>).prisma = {
      server: { findUnique: async () => null },
    };
    await expect(service.restartDetached("nope")).rejects.toThrow(/not found/i);
  });

  it("still answers the Wine port guard synchronously", async () => {
    // The one validation worth keeping in front of the caller: it is cheap, pure,
    // and the alternative is a crash the user has to go and read (GH #39).
    const row = makeRow({
      game: Game.PALWORLD_WINE,
      gamePort: 9000,
      hostNetwork: true,
      state: ServerState.Running,
    });
    const { service } = await makeService(row, docker);
    neuterGuards(service);
    await expect(service.restartDetached(row.id)).rejects.toThrow(/always listens on 8211/);
    expect(docker.createdSpecs.length).toBe(0);
  });
});
