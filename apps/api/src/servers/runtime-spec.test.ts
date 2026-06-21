import { describe, it, expect, beforeAll } from "vitest";
import { Game, type ServerConfigValues } from "@ark/shared";
import { ASA_CATALOG } from "../catalog/asa.catalog";

beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";
});

async function buildAsa(config: ServerConfigValues, cluster: { clusterId: string } | null = null) {
  const { buildContainerSpec } = await import("./runtime-spec");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.ASA,
    map: "TheIsland_WP",
    sessionName: "My Server",
    ports: { game: 7777, rawSocket: 7778, query: 7779, rcon: 27020 },
    maxPlayers: 50,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [111, 222],
    cluster,
    config,
    catalog: ASA_CATALOG,
  });
}

const envOf = (spec: { Env?: string[] }) => spec.Env ?? [];

describe("buildContainerSpec (POK / ASA)", () => {
  it("routes a set MOTD through POK env vars (POK strips the INI section)", async () => {
    const spec = await buildAsa({
      values: { MessageOfTheDay: { message: "Welcome to the server", duration: 45 } },
    });
    const env = envOf(spec);
    expect(env).toContain("ENABLE_MOTD=TRUE");
    expect(env).toContain("MOTD=Welcome to the server");
    expect(env).toContain("MOTD_DURATION=45");
  });

  it("disables MOTD when unset or blank", async () => {
    const env = envOf(await buildAsa({ values: { MessageOfTheDay: { message: "  ", duration: 30 } } }));
    expect(env).toContain("ENABLE_MOTD=FALSE");
    expect(env.some((e) => e.startsWith("MOTD="))).toBe(false);
  });

  it("passes core POK contract vars (ports, mods, RCON, players)", async () => {
    const env = envOf(await buildAsa({ values: {} }));
    expect(env).toContain("ASA_PORT=7777");
    expect(env).toContain("RCON_PORT=27020");
    expect(env).toContain("RCON_ENABLED=TRUE");
    expect(env).toContain("MAX_PLAYERS=50");
    expect(env).toContain("MOD_IDS=111,222");
    expect(env).toContain("MAP_NAME=TheIsland_WP");
  });

  it("sources SERVER_PASSWORD from the plain-text catalog value, else the legacy field", async () => {
    // the visible/editable config value wins...
    expect(envOf(await buildAsa({ values: { ServerPassword: "hunter2" } }))).toContain(
      "SERVER_PASSWORD=hunter2",
    );
    // ...and falls back to the legacy encrypted field ("pw") when it's unset
    expect(envOf(await buildAsa({ values: {} }))).toContain("SERVER_PASSWORD=pw");
  });

  it("mounts a shared cluster dir + sets -ClusterDirOverride when clustered", async () => {
    const spec = await buildAsa({ values: {} }, { clusterId: "cluster-a" });
    const env = envOf(spec);
    expect(env).toContain("CLUSTER_ID=cluster-a"); // POK turns this into -clusterid
    const custom = env.find((e) => e.startsWith("CUSTOM_SERVER_ARGS="));
    expect(custom).toContain("-ClusterDirOverride=/home/pok/clustershared");
    const binds = spec.HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.includes("/clusters/cluster-a:/home/pok/clustershared"))).toBe(true);
  });

  it("omits the cluster dir + override for a standalone server", async () => {
    const spec = await buildAsa({ values: {} });
    const custom = envOf(spec).find((e) => e.startsWith("CUSTOM_SERVER_ARGS=")) ?? "";
    expect(custom).not.toContain("ClusterDirOverride");
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.includes("clustershared"))).toBe(false);
  });
});

async function buildAse(config: ServerConfigValues, cluster: { clusterId: string } | null = null) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { ASE_CATALOG } = await import("../catalog/ase.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.ASE,
    map: "TheIsland",
    sessionName: "My ASE Server",
    ports: { game: 7777, rawSocket: 7778, query: 27015, rcon: 27020 },
    maxPlayers: 40,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [731604991],
    cluster,
    config,
    catalog: ASE_CATALOG,
  });
}

describe("buildContainerSpec (hermsi / ASE)", () => {
  it("maps the server config to hermsi's env contract", async () => {
    const spec = await buildAse({ values: {} });
    const env = envOf(spec);
    expect(spec.Image).toBe("hermsi/ark-server:latest");
    expect(env).toContain("SERVER_MAP=TheIsland");
    expect(env).toContain("SESSION_NAME=My ASE Server");
    expect(env).toContain("ADMIN_PASSWORD=secret");
    expect(env).toContain("MAX_PLAYERS=40");
    expect(env).toContain("GAME_MOD_IDS=731604991");
    expect(env).toContain("GAME_CLIENT_PORT=7777");
    expect(env).toContain("RCON_PORT=27020");
    expect(env).toContain("SERVER_LIST_PORT=27015");
    expect(env).toContain("UPDATE_ON_START=true");
    // hermsi installs game files into /app; INIs live under /app/server/...
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/app"))).toBe(true);
  });

  it("disables BattlEye via DISABLE_BATTLEYE when the flag is set", async () => {
    const off = envOf(await buildAse({ values: { DisableBattlEye: true } }));
    expect(off).toContain("DISABLE_BATTLEYE=true");
    const on = envOf(await buildAse({ values: {} }));
    expect(on).toContain("DISABLE_BATTLEYE=false");
  });

  it("passes cluster args via Cmd + mounts the shared dir when clustered", async () => {
    const spec = await buildAse({ values: {} }, { clusterId: "cl-7" });
    expect(spec.Cmd).toContain("--arkopt,-clusterid=cl-7");
    expect(spec.Cmd).toContain("--arkopt,-ClusterDirOverride=/clustershared");
    expect((spec.HostConfig?.Binds ?? []).some((b) => b.endsWith(":/clustershared"))).toBe(true);
  });

  it("has no Cmd for a standalone ASE server", async () => {
    const spec = await buildAse({ values: {} });
    expect(spec.Cmd).toBeUndefined();
  });
});

async function buildConan(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { CONAN_CATALOG } = await import("../catalog/conan.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.CONAN,
    map: "ConanSandbox",
    sessionName: "My Conan Server",
    ports: { game: 7777, rawSocket: 7778, query: 27015, rcon: 25575 },
    maxPlayers: 40,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [111, 222],
    cluster: null,
    config,
    catalog: CONAN_CATALOG,
  });
}

describe("buildContainerSpec (Conan)", () => {
  it("uses the Conan image and the core env contract", async () => {
    const spec = await buildConan({ values: {} });
    expect(spec.Image).toBe("acekorneya/conan_enhanced_server:latest");
    const env = envOf(spec);
    expect(env).toContain("SERVER_NAME=My Conan Server");
    expect(env).toContain("ADMIN_PASSWORD=secret");
    expect(env).toContain("RCON_PASSWORD=secret"); // RCON authenticates with the admin password
    expect(env).toContain("RCON_PORT=25575");
    expect(env).toContain("SERVER_PORT=7777");
    expect(env).toContain("QUERY_PORT=27015");
    expect(env).toContain("MAX_PLAYERS=40");
    expect(env).toContain("MOD_IDS=111,222");
    expect(env).toContain("AUTO_UPDATE=false"); // manager owns updates
  });

  it("passes catalog settings through as env vars (bools as true/false)", async () => {
    const env = envOf(await buildConan({ values: { PVP_ENABLED: false, XP_RATE_MULTIPLIER: 2 } }));
    expect(env).toContain("PVP_ENABLED=false");
    expect(env).toContain("XP_RATE_MULTIPLIER=2");
  });
});
