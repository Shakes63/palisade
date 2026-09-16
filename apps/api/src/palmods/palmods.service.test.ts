import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { Game } from "@ark/shared";
import {
  PalModsService,
  UE4SS_LINUX,
  UE4SS_WINDOWS,
  PAL_FRAMEWORK_WINE_LOADER,
  PAL_WINE_PROXY_DLLS,
  filterWineProxyDlls,
  PALSCHEMA,
  PAL_SCHEMA_DLL,
  PAL_SCHEMA_ENABLED_MARKER,
} from "./palmods.service";

/** UE4SS ships GuiConsoleEnabled=1 (no display on a dedicated server) and
 *  bUseUObjectArrayCache=true (crashes Palworld). Both must be flipped on install. */
describe("UE4SS headless settings patch", () => {
  let dir: string;
  const svc = new PalModsService({} as never);
  // makeHeadlessSafe is private; it's the whole point of the install path.
  const patch = (d: string) => (svc as unknown as { makeHeadlessSafe(d: string): Promise<void> }).makeHeadlessSafe(d);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "palmods-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flips both hazardous defaults, preserving the rest of the file", async () => {
    await writeFile(
      join(dir, "UE4SS-settings.ini"),
      ["[General]", "EnableHotReloadSystem = 1", "bUseUObjectArrayCache = true", "", "[Debug]", "ConsoleEnabled = 1", "GuiConsoleEnabled = 1", ""].join("\n"),
    );
    await patch(dir);
    const out = await readFile(join(dir, "UE4SS-settings.ini"), "utf8");
    expect(out).toContain("bUseUObjectArrayCache = false");
    expect(out).toContain("GuiConsoleEnabled = 0");
    // Untouched keys survive — including ConsoleEnabled, which is fine headless.
    expect(out).toContain("EnableHotReloadSystem = 1");
    expect(out).toContain("ConsoleEnabled = 1");
    expect(out).toContain("[Debug]");
  });

  it("does not rewrite GuiConsoleEnabled into a capture-group artifact", async () => {
    await writeFile(join(dir, "UE4SS-settings.ini"), "GuiConsoleEnabled = 1\n");
    await patch(dir);
    // "$10" would have produced "GuiConsoleEnabled = 1" (group 1 + '0') or worse.
    expect(await readFile(join(dir, "UE4SS-settings.ini"), "utf8")).toBe("GuiConsoleEnabled = 0\n");
  });

  it("is a no-op when the archive has no UE4SS-settings.ini", async () => {
    await expect(patch(dir)).resolves.toBeUndefined();
  });

  it("pins an exact release asset and digest (never 'latest')", () => {
    expect(UE4SS_LINUX.url).toMatch(/\/releases\/download\/linux-experiment\/UE4SS_0\.0\.0\.zip$/);
    expect(UE4SS_LINUX.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins the official Windows UE4SS build for the Wine variant", () => {
    // Wine loads the official Windows release (a dwmapi.dll proxy), not the Linux fork.
    expect(UE4SS_WINDOWS.url).toMatch(/UE4SS-RE\/RE-UE4SS\/releases\/download\/v[\d.]+\/UE4SS_v[\d.]+\.zip$/);
    expect(UE4SS_WINDOWS.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(PAL_FRAMEWORK_WINE_LOADER).toBe("Pal/Binaries/Win64/dwmapi.dll");
  });
});

/** The framework install dir diverges by variant: native → Pal/Binaries/Linux (.so on
 *  LD_PRELOAD), Wine → Pal/Binaries/Win64 (dwmapi.dll proxy). */
describe("framework dir routing by game", () => {
  // frameworkDir resolves via LocalPaths.instanceRoot, which validates env config.
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";
  const svc = new PalModsService({} as never);
  const isWine = (s: { game: string }) =>
    (svc as unknown as { isWine(s: { game: string }): boolean }).isWine(s);
  const fwDir = (id: string, wine: boolean) =>
    (svc as unknown as { frameworkDir(id: string, wine: boolean): string }).frameworkDir(id, wine);

  it("recognizes the Wine variant", () => {
    expect(isWine({ game: Game.PALWORLD_WINE })).toBe(true);
    expect(isWine({ game: Game.PALWORLD })).toBe(false);
  });

  it("targets Win64 for Wine and Linux for native", () => {
    expect(fwDir("srv1", true).endsWith("Pal/Binaries/Win64")).toBe(true);
    expect(fwDir("srv1", false).endsWith("Pal/Binaries/Linux")).toBe(true);
  });
});

/** GH #20: proxy-loader mods (PalDefender's d3d9.dll) only load under Wine when their
 *  DLL name is in WINEDLLOVERRIDES — detection has to catch them, and ONLY them. */
describe("filterWineProxyDlls", () => {
  it("finds PalDefender's d3d9 loader among the game's own files", () => {
    // A realistic Win64 listing: game exe, Steam + VC runtimes, the mod's loader,
    // and its payload. Only the loader needs (or may get) an override.
    expect(
      filterWineProxyDlls([
        "PalServer-Win64-Shipping-Cmd.exe",
        "steam_api64.dll",
        "vcruntime140.dll",
        "msvcp140.dll",
        "d3d9.dll",
        "PalDefender.dll",
      ]),
    ).toEqual(["d3d9"]);
  });

  it("matches case-insensitively (Windows filenames arrive in any casing)", () => {
    expect(filterWineProxyDlls(["D3D9.DLL", "DWMAPI.dll"])).toEqual(["dwmapi", "d3d9"]);
  });

  it("never flags payload or runtime DLLs — overriding those would break the server", () => {
    // steam_api64/vcruntime natively-overridden would break Steam init; PalDefender.dll
    // is loaded by its d3d9 proxy, not by Wine.
    expect(filterWineProxyDlls(["steam_api64.dll", "vcruntime140.dll", "PalDefender.dll", "PalGuard.dll"])).toEqual([]);
  });

  it("returns list order regardless of directory order, for a stable env string", () => {
    const a = filterWineProxyDlls(["version.dll", "d3d9.dll"]);
    const b = filterWineProxyDlls(["d3d9.dll", "version.dll"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["d3d9", "version"]);
  });

  it("covers the two loaders in the wild today", () => {
    // dwmapi = UE4SS, d3d9 = PalDefender ≥1.5.2. If either leaves the list, those
    // mods silently stop loading again.
    expect(PAL_WINE_PROXY_DLLS).toContain("dwmapi");
    expect(PAL_WINE_PROXY_DLLS).toContain("d3d9");
  });
});

describe("PalSchema pin", () => {
  it("pins an exact release asset and digest (verified against the real downloaded zip)", () => {
    expect(PALSCHEMA.url).toMatch(/\/releases\/download\/[\d.]+\/PalSchema_[\d.]+\.zip$/);
    expect(PALSCHEMA.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The release zip's root IS the "PalSchema" folder, so it extracts straight into
    // UE4SS's Mods dir and lands here.
    expect(PAL_SCHEMA_DLL).toBe("Pal/Binaries/Win64/Mods/PalSchema/dlls/main.dll");
  });
});

/**
 * UE4SS starts a DLL mod from an `enabled.txt` marker in the mod's own folder,
 * NOT from Mods/mods.txt (that's the Lua-mod list). Confirmed against a live
 * server: its UE4SS.log reads "Mod 'PalSchema' has enabled.txt, starting mod."
 * while PalSchema appears nowhere in mods.txt. Writing a mods.txt entry for
 * PalSchema would be cargo-culting.
 */
/**
 * Pak mods are listed recursively (a mod zip ships a `ModName/` folder with the
 * .pak/.ucas/.utoc trio), so delete takes a path with separators rather than a
 * basename — which is exactly the input that needs a traversal guard. It uses the
 * same shared resolveSafe() the file manager does, so these run against a real
 * filesystem with real symlinks rather than asserting on string math.
 */
describe("removePak() containment", () => {
  let dataDir: string;
  let mods: string; // the server's ~mods dir
  let outside: string; // a sibling dir that must stay unreachable
  let svc: PalModsService;

  beforeEach(async () => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
    dataDir = await mkdtemp(join(tmpdir(), "palmods-rm-"));
    process.env.DATA_DIR = dataDir;
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();

    mods = join(dataDir, "instances", "srv1", "Pal/Content/Paks/~mods");
    outside = join(dataDir, "outside");
    await mkdir(join(mods, "ModName"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.pak"), "host-secret");
    await writeFile(join(mods, "loose_P.pak"), "x");
    await writeFile(join(mods, "ModName", "ModName_P.pak"), "x");
    await writeFile(join(mods, "ModName", "ModName_P.ucas"), "x");

    svc = new PalModsService({
      server: { findUnique: async () => ({ id: "srv1", game: Game.PALWORLD, configJson: "{}" }) },
    } as never);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
  });

  const exists = (p: string) => stat(p).then(() => true).catch(() => false);

  it("deletes a nested mod file, the case the flat listing used to miss", async () => {
    await svc.removePak("srv1", "ModName/ModName_P.pak");
    expect(await exists(join(mods, "ModName", "ModName_P.pak"))).toBe(false);
    // Its siblings stay: only the named file goes.
    expect(await exists(join(mods, "ModName", "ModName_P.ucas"))).toBe(true);
  });

  it("deletes a file sitting directly in ~mods", async () => {
    await svc.removePak("srv1", "loose_P.pak");
    expect(await exists(join(mods, "loose_P.pak"))).toBe(false);
  });

  it("drops the mod folder once its last file is gone, and not before", async () => {
    await svc.removePak("srv1", "ModName/ModName_P.pak");
    expect(await exists(join(mods, "ModName"))).toBe(true); // .ucas still there
    await svc.removePak("srv1", "ModName/ModName_P.ucas");
    expect(await exists(join(mods, "ModName"))).toBe(false);
  });

  it("refuses traversal, absolute paths, and null bytes", async () => {
    for (const evil of [
      "../../../../../outside/secret.pak",
      "ModName/../../../../outside/secret.pak",
      "/etc/passwd",
      "a\0b.pak",
    ]) {
      await expect(svc.removePak("srv1", evil), evil).rejects.toThrow(BadRequestException);
    }
    expect(await exists(join(outside, "secret.pak"))).toBe(true);
  });

  it("refuses a delete aimed through a symlinked mod folder", async () => {
    // The shared guard canonicalizes the deepest existing ancestor, which is what
    // the old lexical-only check could not see.
    await symlink(outside, join(mods, "sneaky"));
    await expect(svc.removePak("srv1", "sneaky/secret.pak")).rejects.toThrow(/symlink/i);
    expect(await exists(join(outside, "secret.pak"))).toBe(true);
  });

  it("refuses anything that is not a pak file, including the mods dir itself", async () => {
    await writeFile(join(mods, "readme.txt"), "x");
    for (const bad of ["readme.txt", ".", ""]) {
      await expect(svc.removePak("srv1", bad), bad).rejects.toThrow(/not a pak file/i);
    }
    expect(await exists(mods)).toBe(true);
  });

  it("is a no-op when the ~mods dir was never created", async () => {
    await rm(mods, { recursive: true, force: true });
    await expect(svc.removePak("srv1", "loose_P.pak")).resolves.toMatchObject({ paks: [] });
  });
});

/** PalSchema is a UE4SS mod: without the framework its files sit inert in Mods/ and
 *  never load. Every write path must refuse rather than produce that silent no-op. */
describe("PalSchema requires UE4SS (server-side gate)", () => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  process.env.DATA_DIR = "/data";

  // A Wine server whose instance dir has no UE4SS loader on disk.
  const svc = new PalModsService({
    server: { findUnique: async () => ({ id: "srv1", game: Game.PALWORLD_WINE, configJson: "{}" }) },
  } as never);

  it("refuses the one-click install before spending a download", async () => {
    await expect(svc.installPalSchemaFromUpstream("srv1")).rejects.toThrow(/UE4SS framework first/i);
  });

  it("refuses a manual PalSchema upload too (not just the gated button)", async () => {
    await expect(svc.installPalSchema("srv1", Buffer.from("zip"))).rejects.toThrow(/UE4SS framework first/i);
  });

  it("refuses content-mod uploads", async () => {
    await expect(svc.addPalSchemaMod("srv1", "mod.zip", Buffer.from("zip"))).rejects.toThrow(/UE4SS framework first/i);
  });

  it("rejects PalSchema on the native Linux variant regardless of UE4SS", async () => {
    const native = new PalModsService({
      server: { findUnique: async () => ({ id: "srv2", game: Game.PALWORLD, configJson: "{}" }) },
    } as never);
    await expect(native.installPalSchemaFromUpstream("srv2")).rejects.toThrow(/Wine/i);
  });
});

describe("PalSchema enablement marker", () => {
  it("lives inside the mod folder, beside the dlls dir it enables", () => {
    expect(PAL_SCHEMA_ENABLED_MARKER).toBe("Pal/Binaries/Win64/Mods/PalSchema/enabled.txt");
    const modDir = PAL_SCHEMA_DLL.replace(/\/dlls\/main\.dll$/, "");
    expect(PAL_SCHEMA_ENABLED_MARKER.startsWith(`${modDir}/`)).toBe(true);
  });
});
