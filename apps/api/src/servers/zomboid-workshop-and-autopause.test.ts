import { describe, it, expect, beforeAll } from "vitest";
import { Game, type SettingsCatalog } from "@ark/shared";
import { buildContainerSpec, palworldAutoPauseOn } from "./runtime-spec";
import { ZOMBOID_DATA_DIR, ZOMBOID_WORKSHOP_DIR } from "../common/images";
import { resetEnvCache } from "../config/env";

beforeAll(() => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";
  process.env.GAME_HOST_NETWORK = "false";
  resetEnvCache();
});

const base = (game: Game, values: Record<string, unknown> = {}) =>
  ({
    serverId: "srv1",
    game,
    map: "",
    sessionName: "Test",
    ports: { game: 16261, rawSocket: 16262, query: 16263, rcon: 27015 },
    maxPlayers: 16,
    adminPassword: "changeme",
    modIds: [],
    config: { values },
    catalog: { settings: [] } as unknown as SettingsCatalog,
  }) as unknown as Parameters<typeof buildContainerSpec>[0];

/**
 * GH #57: the danixu86 image keeps Workshop downloads under the game's INSTALL dir,
 * not the Zomboid data dir. Only the data dir was bound, so the Workshop cache lived
 * in the container layer and vanished on every recreate — and every managed restart
 * re-downloaded the whole mod set (124 items, in the report).
 */
describe("Zomboid persists its Workshop cache", () => {
  it("binds the workshop dir alongside the data dir", () => {
    const binds = buildContainerSpec(base(Game.ZOMBOID)).HostConfig?.Binds ?? [];
    expect(binds.some((b) => b.endsWith(`/data:${ZOMBOID_DATA_DIR}`))).toBe(true);
    expect(binds.some((b) => b.endsWith(`/workshop:${ZOMBOID_WORKSHOP_DIR}`))).toBe(true);
  });

  it("keeps the two under the same per-instance root", () => {
    const binds = buildContainerSpec(base(Game.ZOMBOID)).HostConfig?.Binds ?? [];
    const roots = new Set(binds.map((b) => (b.split(":")[0] ?? "").replace(/\/(data|workshop)$/, "")));
    expect(roots.size).toBe(1);
  });
});

/**
 * GH #58: with "Pause when empty" on, the server paused and never woke. The wake
 * side is knockd, which the image runs as its non-root user with NET_RAW via a
 * file capability on the binary — and no-new-privileges forbids that elevation.
 * Reproduced against the real image: the flag alone decides whether knockd can open
 * the interface. So that one container, only while the feature is on, drops the
 * flag and states NET_RAW explicitly.
 */
describe("Palworld auto-pause can actually wake", () => {
  const on = base(Game.PALWORLD, { AUTO_PAUSE_ENABLED: "true" });
  const off = base(Game.PALWORLD, { AUTO_PAUSE_ENABLED: "false" });

  it("recognises the setting only on the native variant", () => {
    expect(palworldAutoPauseOn(on)).toBe(true);
    expect(palworldAutoPauseOn(off)).toBe(false);
    // The Wine variant has no auto-pause; a stray value there must not loosen it.
    expect(palworldAutoPauseOn(base(Game.PALWORLD_WINE, { AUTO_PAUSE_ENABLED: "true" }))).toBe(false);
  });

  it("drops no-new-privileges and grants NET_RAW while the feature is on", () => {
    const host = buildContainerSpec(on).HostConfig ?? {};
    expect(host.SecurityOpt ?? []).not.toContain("no-new-privileges:true");
    expect(host.CapAdd).toEqual(["NET_RAW"]);
  });

  it("stays fully hardened while the feature is off", () => {
    // The exemption must be exactly as wide as the feature, and no wider.
    const host = buildContainerSpec(off).HostConfig ?? {};
    expect(host.SecurityOpt).toContain("no-new-privileges:true");
    expect(host.CapAdd).toBeUndefined();
  });

  it("keeps the pids limit either way", () => {
    // Only the one flag the image's design conflicts with is relaxed.
    expect(buildContainerSpec(on).HostConfig?.PidsLimit).toBe(8192);
  });

  it("does not loosen any other game's container", () => {
    const host = buildContainerSpec(base(Game.VALHEIM, { AUTO_PAUSE_ENABLED: "true" })).HostConfig ?? {};
    expect(host.SecurityOpt).toContain("no-new-privileges:true");
    expect(host.CapAdd).toBeUndefined();
  });
});
