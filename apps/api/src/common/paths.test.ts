import { describe, it, expect, beforeAll } from "vitest";
import { Game } from "@ark/shared";
import { LocalPaths } from "./paths";

// Regression guard: saves live under a game-specific subdir, not the instance root.
// Pointing backup/restore/import at the root silently finds nothing (ENOENT).
beforeAll(() => {
  // loadEnv() validates required secrets; vitest doesn't load .env (see game-cache).
  process.env.DATA_DIR ??= "/data";
  process.env.SECRETS_KEY ??= "a".repeat(64);
  process.env.JWT_SECRET ??= "test-jwt-secret-1234";
});

describe("LocalPaths.savedDir", () => {
  it("resolves ASA (POK, root install) saves to ShooterGame/Saved", () => {
    expect(LocalPaths.savedDir("s1", Game.ASA)).toMatch(/\/instances\/s1\/ShooterGame\/Saved$/);
  });
  it("resolves ASE (hermsi, server/ install) saves to server/ShooterGame/Saved", () => {
    // hermsi installs under <vol>/server, so ASE's Saved is NOT at the instance root.
    expect(LocalPaths.savedDir("s1", Game.ASE)).toMatch(/\/instances\/s1\/server\/ShooterGame\/Saved$/);
  });
  it("resolves Conan saves to server/ConanSandbox/Saved", () => {
    expect(LocalPaths.savedDir("s1", Game.CONAN)).toMatch(
      /\/instances\/s1\/server\/ConanSandbox\/Saved$/,
    );
  });
});

describe("LocalPaths.saveSubpaths", () => {
  it("captures Minecraft's overworld + Paper/Spigot dimension siblings", () => {
    expect(LocalPaths.saveSubpaths(Game.MINECRAFT)).toEqual(["world", "world_nether", "world_the_end"]);
  });
  it("captures Bedrock's worlds AND the add-on pack folders", () => {
    expect(LocalPaths.saveSubpaths(Game.BEDROCK)).toEqual(["worlds", "behavior_packs", "resource_packs"]);
  });
  it("uses ASE's server/ prefix (not the ASA root path)", () => {
    expect(LocalPaths.saveSubpaths(Game.ASE)).toEqual(["server/ShooterGame/Saved"]);
    expect(LocalPaths.saveSubpaths(Game.ASA)).toEqual(["ShooterGame/Saved"]);
  });
  it("uses Enshrouded's server/savegame path (image installs under /opt/enshrouded/server)", () => {
    expect(LocalPaths.saveSubpaths(Game.ENSHROUDED)).toEqual(["gamefiles/server/savegame"]);
  });
  it("uses Dragonwilds' SaveGames dir (capital G) inside the gamefiles bind", () => {
    expect(LocalPaths.saveSubpaths(Game.DRAGONWILDS)).toEqual(["gamefiles/RSDragonwilds/Saved/SaveGames"]);
  });
});
