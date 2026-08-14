import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game } from "@ark/shared";
import {
  PalModsService,
  UE4SS_LINUX,
  UE4SS_WINDOWS,
  PAL_FRAMEWORK_WINE_LOADER,
  PAL_WINE_PROXY_DLLS,
  filterWineProxyDlls,
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
