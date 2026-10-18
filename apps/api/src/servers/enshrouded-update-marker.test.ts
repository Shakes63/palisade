import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType, Game, ServerState } from "@ark/shared";
import { FakeDocker, makeRow, makeService, neuterGuards, setupE2eEnv, startServer } from "./lifecycle-harness";

beforeAll(setupE2eEnv);

const ACF = (buildid: string) => `"AppState"\n{\n\t"appid"\t\t"2278520"\n\t"buildid"\t\t"${buildid}"\n}\n`;
const exists = (p: string) => access(p).then(() => true, () => false);

describe("clearStaleEnshroudedMarker", () => {
  let gamefiles: string;
  let steamapps: string;
  let marker: string;

  beforeEach(async () => {
    gamefiles = await mkdtemp(join(tmpdir(), "ensh-"));
    steamapps = join(gamefiles, "server", "steamapps");
    marker = join(gamefiles, "current_version");
    await mkdir(join(steamapps, "downloading"), { recursive: true });
  });
  afterEach(() => rm(gamefiles, { recursive: true, force: true }));

  async function clear() {
    const { clearStaleEnshroudedMarker } = await import("./servers.service");
    return clearStaleEnshroudedMarker(gamefiles);
  }

  it("clears a marker ahead of the installed build, with steamapps (the #173 state)", async () => {
    await writeFile(marker, "25967645\n");
    await writeFile(join(steamapps, "appmanifest_2278520.acf"), ACF("25936466"));
    expect(await clear()).toBe(true);
    expect(await exists(marker)).toBe(false);
    expect(await exists(steamapps)).toBe(false);
    expect(await exists(join(gamefiles, "server"))).toBe(true);
  });

  it("leaves a marker that matches the installed build", async () => {
    await writeFile(marker, "25967645\n");
    await writeFile(join(steamapps, "appmanifest_2278520.acf"), ACF("25967645"));
    expect(await clear()).toBe(false);
    expect(await exists(marker)).toBe(true);
    expect(await exists(join(steamapps, "appmanifest_2278520.acf"))).toBe(true);
  });

  it("clears a marker with no manifest behind it", async () => {
    await writeFile(marker, "25967645\n");
    expect(await clear()).toBe(true);
    expect(await exists(marker)).toBe(false);
    expect(await exists(steamapps)).toBe(false);
  });

  it("does nothing before the image has written a marker", async () => {
    await writeFile(join(steamapps, "appmanifest_2278520.acf"), ACF("25936466"));
    expect(await clear()).toBe(false);
    expect(await exists(steamapps)).toBe(true);
  });
});

describe("Enshrouded start", () => {
  it("clears a stale marker before the container is created", async () => {
    const row = makeRow({ game: Game.ENSHROUDED, id: "ensh-stale", map: "Enshrouded" });
    const gamefiles = join(process.env.DATA_DIR as string, "instances", row.id, "gamefiles");
    await mkdir(join(gamefiles, "server", "steamapps"), { recursive: true });
    await writeFile(join(gamefiles, "current_version"), "25967645\n");
    await writeFile(join(gamefiles, "server", "steamapps", "appmanifest_2278520.acf"), ACF("25936466"));
    const docker = new FakeDocker();
    docker.logScript = ["[Session] 'HostOnline' (up)!"];
    const { service, emitted } = await makeService(row, docker);
    neuterGuards(service);
    await startServer(service, row.id);
    await new Promise((r) => setTimeout(r, 25));
    expect(row.state).toBe(ServerState.Running);
    expect(await exists(join(gamefiles, "current_version"))).toBe(false);
    expect(await exists(join(gamefiles, "server", "steamapps"))).toBe(false);
    expect(emitted.some((e) => e.type === EventType.InstallStarted && e.serverId === row.id)).toBe(true);
  });
});
