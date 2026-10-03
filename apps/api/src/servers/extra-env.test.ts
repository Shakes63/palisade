import "reflect-metadata"; // class-transformer/-validator decorators; main.ts does this in the app
import { describe, it, expect, beforeAll } from "vitest";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { Game, type ServerConfigValues } from "@ark/shared";
import { ExtraEnvBody } from "./servers.dto";
import { buildContainerSpec, needsSteamCmdForPin } from "./runtime-spec";
import { PALWORLD_CATALOG } from "../catalog/palworld.catalog";
import { PALWORLD_WINE_CATALOG } from "../catalog/palworld-wine.catalog";
import { CONAN_CATALOG } from "../catalog/conan.catalog";

beforeAll(() => {
  process.env.DATA_DIR ??= "/data";
  process.env.SECRETS_KEY ??= "a".repeat(64);
  process.env.JWT_SECRET ??= "test-jwt-secret-1234";
});

const envOf = (spec: { Env?: string[] }) => spec.Env ?? [];
const base = {
  serverId: "srv1",
  game: Game.PALWORLD,
  map: "",
  sessionName: "Pal",
  ports: { game: 8211, rawSocket: 0, query: 27015, rcon: 25575 },
  maxPlayers: 16,
  adminPassword: "secret",
  serverPassword: null,
  modIds: [],
  cluster: null,
  config: { values: {} } as ServerConfigValues,
  catalog: PALWORLD_CATALOG,
};

describe("extraEnv injection", () => {
  it("appends custom vars to the container env", () => {
    const env = envOf(buildContainerSpec({ ...base, extraEnv: [{ key: "MY_VAR", value: "hello" }] }));
    expect(env).toContain("MY_VAR=hello");
  });

  it("appends them LAST so they override a manager-set key", () => {
    // Docker keeps the last duplicate, which is the whole point of the feature:
    // an advanced user can override anything the manager set.
    const env = envOf(buildContainerSpec({ ...base, extraEnv: [{ key: "PLAYERS", value: "99" }] }));
    const idxManager = env.indexOf("PLAYERS=16");
    const idxUser = env.lastIndexOf("PLAYERS=99");
    expect(idxManager).toBeGreaterThanOrEqual(0);
    expect(idxUser).toBeGreaterThan(idxManager);
  });

  it("is a no-op when unset or empty", () => {
    const none = envOf(buildContainerSpec({ ...base }));
    const empty = envOf(buildContainerSpec({ ...base, extraEnv: [] }));
    expect(empty).toEqual(none);
  });

  it("keeps values containing '=' intact", () => {
    // A base64 secret or a query string must not be split on the first '='.
    const env = envOf(buildContainerSpec({ ...base, extraEnv: [{ key: "TOKEN", value: "ab=cd==" }] }));
    expect(env).toContain("TOKEN=ab=cd==");
  });
});

describe("needsSteamCmdForPin", () => {
  // TARGET_MANIFEST_ID names WHICH build to fetch; it does nothing unless SteamCMD
  // runs on boot, so pinning silently failed without this (original PR #11).
  it("asks for SteamCMD when a manifest is pinned", () => {
    expect(needsSteamCmdForPin(Game.PALWORLD, [{ key: "TARGET_MANIFEST_ID", value: "123" }])).toBe(true);
  });

  it("stands down when the user set the update switch themselves", () => {
    expect(
      needsSteamCmdForPin(Game.PALWORLD, [
        { key: "TARGET_MANIFEST_ID", value: "123" },
        { key: "UPDATE_ON_BOOT", value: "false" },
      ]),
    ).toBe(false);
  });

  it("ignores a pin on images that never read TARGET_MANIFEST_ID (GH #168)", () => {
    const pin = [{ key: "TARGET_MANIFEST_ID", value: "123" }];
    expect(needsSteamCmdForPin(Game.PALWORLD_WINE, pin)).toBe(false);
    expect(needsSteamCmdForPin(Game.CONAN, pin)).toBe(false);
  });

  it("is quiet without a pin", () => {
    expect(needsSteamCmdForPin(Game.PALWORLD, [{ key: "OTHER", value: "x" }])).toBe(false);
    expect(needsSteamCmdForPin(Game.PALWORLD, [])).toBe(false);
    expect(needsSteamCmdForPin(Game.PALWORLD, undefined)).toBe(false);
  });

  it("turns UPDATE_ON_BOOT on exactly once for a pinned Palworld build", () => {
    const env = envOf(
      buildContainerSpec({ ...base, extraEnv: [{ key: "TARGET_MANIFEST_ID", value: "42" }] }),
    );
    expect(env.filter((e) => e.startsWith("UPDATE_ON_BOOT="))).toEqual(["UPDATE_ON_BOOT=true"]);
    expect(env).toContain("TARGET_MANIFEST_ID=42");
  });

  it("leaves the user's own switch alone when they override it", () => {
    const env = envOf(
      buildContainerSpec({
        ...base,
        extraEnv: [
          { key: "TARGET_MANIFEST_ID", value: "42" },
          { key: "UPDATE_ON_BOOT", value: "false" },
        ],
      }),
    );
    expect(env.lastIndexOf("UPDATE_ON_BOOT=false")).toBeGreaterThan(-1);
    expect(env).not.toContain("UPDATE_ON_BOOT=true");
  });

  it("leaves Conan's updater off for a pin its image ignores (GH #168)", () => {
    const pinned = (extraEnv: { key: string; value: string }[]) =>
      envOf(buildContainerSpec({ ...base, game: Game.CONAN, catalog: CONAN_CATALOG, extraEnv }));
    const env = pinned([{ key: "TARGET_MANIFEST_ID", value: "42" }]);
    expect(env.filter((e) => e.startsWith("AUTO_UPDATE="))).toEqual(["AUTO_UPDATE=false"]);
    expect(env).not.toContain("AUTO_UPDATE_CHECK_INTERVAL_HOURS=24");
    const explicit = pinned([
      { key: "TARGET_MANIFEST_ID", value: "42" },
      { key: "AUTO_UPDATE", value: "false" },
    ]);
    expect(explicit).not.toContain("AUTO_UPDATE=true");
  });

  it("leaves Palworld Wine's updater off for a pin its image ignores (GH #168)", () => {
    const env = envOf(
      buildContainerSpec({
        ...base,
        game: Game.PALWORLD_WINE,
        catalog: PALWORLD_WINE_CATALOG,
        extraEnv: [{ key: "TARGET_MANIFEST_ID", value: "42" }],
      }),
    );
    expect(env.filter((e) => e.startsWith("ALWAYS_UPDATE_ON_START="))).toEqual(["ALWAYS_UPDATE_ON_START=false"]);
  });
});

describe("ExtraEnvBody validation", () => {
  const check = async (extraEnv: unknown) =>
    validate(plainToInstance(ExtraEnvBody, { extraEnv }), { whitelist: true });

  it("accepts ordinary POSIX names", async () => {
    expect(await check([{ key: "STEAM_USERNAME", value: "bob" }, { key: "_X1", value: "" }])).toEqual([]);
  });

  it("rejects a name starting with a digit", async () => {
    expect((await check([{ key: "1BAD", value: "x" }])).length).toBeGreaterThan(0);
  });

  it("rejects names with a dash, space or equals", async () => {
    for (const key of ["MY-VAR", "MY VAR", "MY=VAR", ""]) {
      expect((await check([{ key, value: "x" }])).length, key).toBeGreaterThan(0);
    }
  });

  it("rejects a null byte in the value", async () => {
    // A NUL would truncate the variable inside the container. Built at runtime so
    // this source file stays free of control characters.
    const withNul = `a${String.fromCharCode(0)}b`;
    expect((await check([{ key: "K", value: withNul }])).length).toBeGreaterThan(0);
  });

  it("rejects an oversized value", async () => {
    expect((await check([{ key: "K", value: "x".repeat(4097) }])).length).toBeGreaterThan(0);
    expect(await check([{ key: "K", value: "x".repeat(4096) }])).toEqual([]);
  });

  it("caps the list at 64 entries", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `K${i}`, value: "v" }));
    expect(await check(many(64))).toEqual([]);
    expect((await check(many(65))).length).toBeGreaterThan(0);
  });
});
