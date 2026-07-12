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
