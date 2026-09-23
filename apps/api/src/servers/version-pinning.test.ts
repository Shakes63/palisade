import { describe, it, expect, beforeAll } from "vitest";
import { Game, type ServerConfigValues } from "@ark/shared";

beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";
});

const envOf = (spec: { Env?: string[] }) => spec.Env ?? [];

async function buildOpenttd(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { OPENTTD_CATALOG } = await import("../catalog/openttd.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.OPENTTD,
    map: "temperate",
    sessionName: "TTD",
    ports: { game: 3979, rawSocket: 3979, query: 3979, rcon: 3977 },
    maxPlayers: 8,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [],
    cluster: null,
    config,
    catalog: OPENTTD_CATALOG,
  });
}

async function buildSdtd(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { SEVEN_DAYS_CATALOG } = await import("../catalog/seven-days.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.SEVEN_DAYS,
    map: "Navezgane",
    sessionName: "7DTD",
    ports: { game: 26900, rawSocket: 26901, query: 26902, rcon: 8081 },
    maxPlayers: 8,
    adminPassword: "secret",
    serverPassword: "pw",
    modIds: [],
    cluster: null,
    config,
    catalog: SEVEN_DAYS_CATALOG,
  });
}

async function buildEnshrouded(config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const { ENSHROUDED_CATALOG } = await import("../catalog/enshrouded.catalog");
  return buildContainerSpec({
    serverId: "srv1",
    game: Game.ENSHROUDED,
    map: "Enshrouded",
    sessionName: "Ensh",
    ports: { game: 15636, rawSocket: 15637, query: 15637, rcon: 0 },
    maxPlayers: 8,
    adminPassword: "secret",
    serverPassword: "hunter2",
    modIds: [],
    cluster: null,
    config,
    catalog: ENSHROUDED_CATALOG,
  });
}

async function buildEnvGame(game: Game, catalogName: string, config: ServerConfigValues) {
  const { buildContainerSpec } = await import("./runtime-spec");
  const catalogs = await import("../catalog/" + catalogName);
  const catalog = (catalogs as Record<string, unknown>)[
    Object.keys(catalogs).find((k) => k.endsWith("_CATALOG")) as string
  ];
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
    config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    catalog: catalog as any,
  });
}

describe("ich777GameId", () => {
  it("uses the bare appid for public, appends -beta for a branch", async () => {
    const { ich777GameId } = await import("./runtime-spec");
    expect(ich777GameId(2239530, undefined)).toBe("2239530");
    expect(ich777GameId(2239530, "public")).toBe("2239530");
    expect(ich777GameId(2239530, "temporary_1_53")).toBe("2239530 -beta temporary_1_53");
    expect(ich777GameId(320850, "dx9-legacy")).toBe("320850 -beta dx9-legacy");
    expect(ich777GameId(2239530, "bad branch!")).toBe("2239530"); // junk → default public
  });
});

describe("new Steam-game version toggles", () => {
  it("Valheim PUBLIC_TEST: default false, honours true", async () => {
    expect(envOf(await buildEnvGame(Game.VALHEIM, "valheim.catalog", { values: {} }))).toContain("PUBLIC_TEST=false");
    expect(
      envOf(await buildEnvGame(Game.VALHEIM, "valheim.catalog", { values: { PUBLIC_TEST: "true" } })),
    ).toContain("PUBLIC_TEST=true");
  });

  it("Palworld INSTALL_BETA_INSIDER: default false, honours true", async () => {
    expect(
      envOf(await buildEnvGame(Game.PALWORLD, "palworld.catalog", { values: {} })),
    ).toContain("INSTALL_BETA_INSIDER=false");
    expect(
      envOf(await buildEnvGame(Game.PALWORLD, "palworld.catalog", { values: { INSTALL_BETA_INSIDER: "true" } })),
    ).toContain("INSTALL_BETA_INSIDER=true");
  });

  it("V Rising BRANCH: current (empty) emits nothing, legacy pins the branch", async () => {
    const cur = envOf(await buildEnvGame(Game.VRISING, "vrising.catalog", { values: {} }));
    expect(cur.some((e) => e.startsWith("BRANCH="))).toBe(false);
    expect(
      envOf(await buildEnvGame(Game.VRISING, "vrising.catalog", { values: { BRANCH: "legacy-1.0.x-pc" } })),
    ).toContain("BRANCH=legacy-1.0.x-pc");
  });

  it("ATS/ETS2 STEAM_BRANCH → GAME_ID -beta, never a server_config.sii key", async () => {
    expect(envOf(await buildEnvGame(Game.ATS, "ats.catalog", { values: {} }))).toContain("GAME_ID=2239530");
    expect(
      envOf(await buildEnvGame(Game.ETS2, "ats.catalog", { values: { STEAM_BRANCH: "temporary_1_53" } })),
    ).toContain("GAME_ID=1948160 -beta temporary_1_53");

    const { patchAtsServerConfig } = await import("./runtime-spec");
    const { ATS_CATALOG } = await import("../catalog/ats.catalog");
    const sii = patchAtsServerConfig(`SiiNunit {\n server_config : .config {\n lobby_name: ""\n }\n}`, {
      sessionName: "S",
      serverPassword: "",
      maxPlayers: 8,
      gamePort: 100,
      queryPort: 102,
      catalog: ATS_CATALOG,
      config: { values: { STEAM_BRANCH: "temporary_1_53" } },
    });
    expect(sii).not.toMatch(/STEAM_BRANCH/);
  });

  it("LiF STEAM_BRANCH → GAME_ID -beta, never a world_1.xml tag", async () => {
    expect(envOf(await buildEnvGame(Game.LIF, "lif.catalog", { values: {} }))).toContain("GAME_ID=320850");
    expect(
      envOf(await buildEnvGame(Game.LIF, "lif.catalog", { values: { STEAM_BRANCH: "dx9-legacy" } })),
    ).toContain("GAME_ID=320850 -beta dx9-legacy");

    const { patchLifWorldXml } = await import("./runtime-spec");
    const { LIF_CATALOG } = await import("../catalog/lif.catalog");
    const xml = patchLifWorldXml(`<world><name>x</name><password></password></world>`, {
      sessionName: "S",
      serverPassword: "",
      adminPassword: "",
      maxPlayers: 8,
      gamePort: 100,
      catalog: LIF_CATALOG,
      config: { values: { STEAM_BRANCH: "dx9-legacy" } },
    });
    expect(xml).not.toMatch(/STEAM_BRANCH/);
  });
});

describe("GAME_VERSION_PINNING classification", () => {
  it("classifies every game and matches the wired-up controls", async () => {
    const { GAME_VERSION_PINNING } = await import("@ark/shared");
    // Every enum member is present (Record<Game,…> already forces this at compile time).
    expect(Object.keys(GAME_VERSION_PINNING).length).toBe(Object.values(Game).length);
    expect(GAME_VERSION_PINNING[Game.VALHEIM]).toBe("game-version");
    expect(GAME_VERSION_PINNING[Game.ATS]).toBe("game-version");
    expect(GAME_VERSION_PINNING[Game.FACTORIO]).toBe("image-tag");
    expect(GAME_VERSION_PINNING[Game.TERRARIA]).toBe("image-tag");
    expect(GAME_VERSION_PINNING[Game.RUST]).toBe("none");
    expect(GAME_VERSION_PINNING[Game.ZOMBOID]).toBe("none");
  });
});

describe("gameVersionValue", () => {
  it("keeps a valid version/branch token, falls back otherwise", async () => {
    const { gameVersionValue } = await import("./runtime-spec");
    for (const ok of ["1.20.4", "26.3-snapshot-3", "15.3", "16.0-beta1", "latest", "stable", "LATEST", "latest_experimental"]) {
      expect(gameVersionValue(ok, "x"), ok).toBe(ok);
    }
    // blank / wrong type / shell-ish junk → default
    for (const bad of ["", "  ", "a b", "v1;rm -rf", "$(x)", null, undefined, 5]) {
      expect(gameVersionValue(bad as unknown, "DEF"), String(bad)).toBe("DEF");
    }
    expect(gameVersionValue("  1.21.4  ", "DEF")).toBe("1.21.4"); // trimmed
  });
});

describe("OpenTTD GAME_VERSION pin", () => {
  it("defaults to latest, honours a pinned version, and never leaks into openttd.cfg", async () => {
    expect(envOf(await buildOpenttd({ values: {} }))).toContain("GAME_VERSION=latest");
    expect(envOf(await buildOpenttd({ values: { GAME_VERSION: "15.3" } }))).toContain("GAME_VERSION=15.3");
    // A junk value can't reach the launch script — falls back to latest.
    expect(envOf(await buildOpenttd({ values: { GAME_VERSION: "no good" } }))).toContain("GAME_VERSION=latest");

    // noEmit: the cfg renderer must not write GAME_VERSION into any of the 3 files.
    const { renderOpenttdConfig } = await import("./runtime-spec");
    const { OPENTTD_CATALOG } = await import("../catalog/openttd.catalog");
    const files = renderOpenttdConfig({
      sessionName: "TTD",
      serverPassword: "pw",
      adminPassword: "secret",
      maxPlayers: 8,
      map: "temperate",
      gamePort: 3979,
      adminPort: 3977,
      catalog: OPENTTD_CATALOG,
      config: { values: { GAME_VERSION: "15.3" } },
    });
    expect(Object.values(files).join("\n")).not.toMatch(/GAME_VERSION/);
  });
});

describe("7DTD VERSION pin", () => {
  it("defaults to stable, honours experimental, and never becomes an XML property", async () => {
    expect(envOf(await buildSdtd({ values: {} }))).toContain("VERSION=stable");
    expect(envOf(await buildSdtd({ values: { VERSION: "latest_experimental" } }))).toContain(
      "VERSION=latest_experimental",
    );

    // noEmit: renderSdtdServerXml must not emit a <property name="VERSION">.
    const { renderSdtdServerXml } = await import("./runtime-spec");
    const { SEVEN_DAYS_CATALOG } = await import("../catalog/seven-days.catalog");
    const xml = renderSdtdServerXml({
      sessionName: "7DTD",
      serverPassword: "pw",
      adminPassword: "secret",
      maxPlayers: 8,
      map: "Navezgane",
      gamePort: 26900,
      telnetPort: 8081,
      catalog: SEVEN_DAYS_CATALOG,
      config: { values: { VERSION: "latest_experimental" } },
    });
    expect(xml).not.toMatch(/name="VERSION"/);
  });

  it("writes EACEnabled, on unless the user turns it off", async () => {
    const { renderSdtdServerXml } = await import("./runtime-spec");
    const { SEVEN_DAYS_CATALOG } = await import("../catalog/seven-days.catalog");
    const render = (values: Record<string, unknown>) =>
      renderSdtdServerXml({
        sessionName: "7DTD",
        serverPassword: "pw",
        adminPassword: "secret",
        maxPlayers: 8,
        map: "Navezgane",
        gamePort: 26900,
        telnetPort: 8081,
        catalog: SEVEN_DAYS_CATALOG,
        config: { values },
      });
    expect(render({})).toContain('<property name="EACEnabled" value="true"/>');
    expect(render({ EACEnabled: false })).toContain('<property name="EACEnabled" value="false"/>');
  });
});

describe("Enshrouded GAME_BRANCH pin", () => {
  it("defaults to public and honours the testing branch (emitted once)", async () => {
    const def = envOf(await buildEnshrouded({ values: {} }));
    expect(def.filter((e) => e.startsWith("GAME_BRANCH="))).toEqual(["GAME_BRANCH=public"]);
    expect(envOf(await buildEnshrouded({ values: { GAME_BRANCH: "testing" } }))).toContain("GAME_BRANCH=testing");
  });
});

describe("Minecraft VERSION dropdown flag", () => {
  it("marks the VERSION setting as a dynamic game-version dropdown", async () => {
    const { MINECRAFT_CATALOG } = await import("../catalog/minecraft.catalog");
    const version = MINECRAFT_CATALOG.settings.find((s) => s.key === "VERSION");
    expect(version?.optionsSource).toBe("game-versions");
    expect(version?.default).toBe("LATEST"); // default stays LATEST
  });
});

describe("native Palworld UPDATE_ON_BOOT (GH #8/#12/#16)", () => {
  const build = async (values: Record<string, unknown>) => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { PALWORLD_CATALOG } = await import("../catalog/palworld.catalog");
    return buildContainerSpec({
      serverId: "srv1",
      game: Game.PALWORLD,
      map: "",
      sessionName: "Pal",
      ports: { game: 8211, rawSocket: 0, query: 27015, rcon: 25575 },
      maxPlayers: 16,
      adminPassword: "secret",
      serverPassword: "hunter2",
      modIds: [],
      cluster: null,
      config: { values } as ServerConfigValues,
      catalog: PALWORLD_CATALOG,
    });
  };

  it("defaults to false via the catalog, emitted exactly once (no leftover pin)", async () => {
    const env = envOf(await build({}));
    expect(env.filter((e) => e.startsWith("UPDATE_ON_BOOT="))).toEqual(["UPDATE_ON_BOOT=false"]);
  });

  it("emits a configured true lowercased (image-script env, not a True/False INI bool)", async () => {
    const env = envOf(await build({ UPDATE_ON_BOOT: "true" }));
    expect(env).toContain("UPDATE_ON_BOOT=true");
  });
});

describe("Palworld community + auto-pause (GH #7)", () => {
  const build = async (values: Record<string, unknown>) => {
    const { buildContainerSpec } = await import("./runtime-spec");
    const { PALWORLD_CATALOG } = await import("../catalog/palworld.catalog");
    return buildContainerSpec({
      serverId: "srv1",
      game: Game.PALWORLD,
      map: "Palpagos",
      sessionName: "S",
      ports: { game: 8211, rawSocket: 8212, query: 27015, rcon: 25575 },
      maxPlayers: 8,
      adminPassword: "secret",
      serverPassword: "hunter2",
      modIds: [],
      cluster: null,
      config: { values } as ServerConfigValues,
      catalog: PALWORLD_CATALOG,
    });
  };
  const envOf2 = (spec: { Env?: string[] }) => spec.Env ?? [];

  it("COMMUNITY + CROSSPLAY_PLATFORMS emit lowercase/verbatim; defaults keep the server unlisted", async () => {
    const def = envOf2(await build({}));
    expect(def).toContain("COMMUNITY=false");
    expect(def).toContain("CROSSPLAY_PLATFORMS=(Steam,Xbox,PS5,Mac)");
    const on = envOf2(await build({ COMMUNITY: "true", CROSSPLAY_PLATFORMS: "(Steam)" }));
    expect(on).toContain("COMMUNITY=true");
    expect(on).toContain("CROSSPLAY_PLATFORMS=(Steam)");
  });

  it("enabling auto-pause also enables its image prerequisites", async () => {
    const off = envOf2(await build({}));
    expect(off.some((e) => e.startsWith("REST_API_ENABLED="))).toBe(false);
    const on = envOf2(await build({ AUTO_PAUSE_ENABLED: "true" }));
    expect(on).toContain("AUTO_PAUSE_ENABLED=true");
    expect(on).toContain("ENABLE_PLAYER_LOGGING=true");
    expect(on).toContain("REST_API_ENABLED=true");
  });
});

describe("7DTD cron-spool tmpfs (GH #19)", () => {
  it("mounts a world-writable tmpfs over /var/spool/cron so the image's crontab install can't crash the boot", async () => {
    const spec = await buildSdtd({ values: {} });
    expect(spec.HostConfig?.Tmpfs).toMatchObject({ "/var/spool/cron": "rw,mode=1777" });
  });
});
