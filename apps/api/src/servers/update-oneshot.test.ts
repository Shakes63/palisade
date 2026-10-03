import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Game, ServerState, type ServerConfigValues, type SettingsCatalog } from "@ark/shared";
import { FakeDocker, makeRow, makeService, neuterGuards, setupE2eEnv, startServer } from "./lifecycle-harness";

beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";
});

const envOf = (spec: { Env?: string[] }) => spec.Env ?? [];

async function build(game: Game, catalogName: string, updateRequested: boolean, values: Record<string, unknown> = {}) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const catalogs = await import("../catalog/" + catalogName);
  const catalog = (catalogs as Record<string, unknown>)[
    Object.keys(catalogs).find((k) => k.endsWith("_CATALOG")) as string
  ] as SettingsCatalog;
  return buildContainerSpec({
    serverId: "srv1",
    game,
    map: "m",
    sessionName: "S",
    ports: { game: 100, rawSocket: 101, query: 102, rcon: 103 },
    maxPlayers: 8,
    adminPassword: "secret",
    serverPassword: "hunter2",
    modIds: [],
    cluster: null,
    config: { values } as ServerConfigValues,
    catalog,
    updateRequested,
  });
}

/** GH #8/#12/#14: games whose image updater the manager disables get a ONE-SHOT
 *  update env when updateRequested is set — and stay off otherwise. */
describe("one-shot game update env", () => {
  it("Palworld: UPDATE_ON_BOOT forced true for the update boot, default false otherwise", async () => {
    const off = envOf(await build(Game.PALWORLD, "palworld.catalog", false));
    expect(off.filter((e) => e.startsWith("UPDATE_ON_BOOT="))).toEqual(["UPDATE_ON_BOOT=false"]);
    const on = envOf(await build(Game.PALWORLD, "palworld.catalog", true));
    // exactly once — no duplicate for Docker's dedupe order to decide
    expect(on.filter((e) => e.startsWith("UPDATE_ON_BOOT="))).toEqual(["UPDATE_ON_BOOT=true"]);
  });

  it("Palworld: the one-shot overrides even an explicit catalog false", async () => {
    const on = envOf(await build(Game.PALWORLD, "palworld.catalog", true, { UPDATE_ON_BOOT: "false" }));
    expect(on.filter((e) => e.startsWith("UPDATE_ON_BOOT="))).toEqual(["UPDATE_ON_BOOT=true"]);
  });

  it("Palworld Wine: ALWAYS_UPDATE_ON_START forced true for the update boot", async () => {
    const off = envOf(await build(Game.PALWORLD_WINE, "palworld-wine.catalog", false));
    expect(off.filter((e) => e.startsWith("ALWAYS_UPDATE_ON_START="))).toEqual(["ALWAYS_UPDATE_ON_START=false"]);
    const on = envOf(await build(Game.PALWORLD_WINE, "palworld-wine.catalog", true));
    expect(on.filter((e) => e.startsWith("ALWAYS_UPDATE_ON_START="))).toEqual(["ALWAYS_UPDATE_ON_START=true"]);
  });

  it("Conan: AUTO_UPDATE forced true with the in-session monitor quieted", async () => {
    const off = envOf(await build(Game.CONAN, "conan.catalog", false));
    expect(off).toContain("AUTO_UPDATE=false");
    const on = envOf(await build(Game.CONAN, "conan.catalog", true));
    expect(on.filter((e) => e.startsWith("AUTO_UPDATE="))).toEqual(["AUTO_UPDATE=true"]);
    // AUTO_UPDATE=true also arms the image's update monitor; 24 h is its slowest
    // interval, and anything above makes the image exit (GH #164).
    expect(on).toContain("AUTO_UPDATE_CHECK_INTERVAL_HOURS=24");
  });

  it("no-op for a game that already updates on boot (ASE)", async () => {
    const on = envOf(await build(Game.ASE, "ase.catalog", true));
    expect(on).toContain("UPDATE_ON_START=true"); // the image's normal on-boot update
    expect(on.some((e) => e.startsWith("AUTO_UPDATE="))).toBe(false);
  });
});

describe("forceEnv", () => {
  it("strips existing entries instead of appending duplicates", async () => {
    const { forceEnv } = await import("./runtime-spec");
    expect(forceEnv(["A=1", "B=2", "A=3"], { A: "9" })).toEqual(["B=2", "A=9"]);
    expect(forceEnv([], { X: "y" })).toEqual(["X=y"]);
  });
});

describe("one-shot flag lifecycle", () => {
  beforeAll(setupE2eEnv);
  let docker: FakeDocker;
  beforeEach(() => {
    docker = new FakeDocker();
  });

  it("a start consumes updateRequested (next start is a normal boot)", async () => {
    const row = makeRow({ game: Game.MINECRAFT, id: "oneshot", map: "world" });
    row.updateRequested = true;
    docker.logScript = ['[Server thread/INFO]: Done (8.488s)! For help, type "help"'];
    const { service } = await makeService(row, docker);
    neuterGuards(service);
    await startServer(service, row.id);
    await new Promise((r) => setTimeout(r, 25));
    expect(row.state).toBe(ServerState.Running);
    expect(row.updateRequested, "flag consumed by the start that applied it").toBe(false);
  });
});
