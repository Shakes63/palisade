import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { mkdir, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { Game, type ServerConfigValues } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LocalPaths } from "../common/paths";
import { extractZipSafe } from "../common/safe-extract";


/** UE4SS drops its loader here; the server is launched with this on LD_PRELOAD
 *  (set by buildPalworldSpec when the framework is enabled). Official UE4SS is
 *  Windows-only — the Linux .so comes from the experimental fork
 *  https://github.com/Yangff/RE-UE4SS/releases/tag/linux-experiment (libUE4SS.so
 *  sits at the archive root, so extracting into Pal/Binaries/Linux lands it here). */
export const PAL_FRAMEWORK_DEFAULT_PRELOAD = "Pal/Binaries/Linux/libUE4SS.so";

/**
 * The one-click UE4SS install. Pinned to an exact release asset (not "latest"):
 * this is an unofficial fork whose artifact gets preloaded into the game process,
 * so we verify its digest before extracting rather than trusting whatever the URL
 * serves today. Bump BOTH fields together when moving to a newer build.
 */
export const UE4SS_LINUX = {
  url: "https://github.com/Yangff/RE-UE4SS/releases/download/linux-experiment/UE4SS_0.0.0.zip",
  sha256: "69d619b17596a4244d9af48cf6d690dc9946bc15fab2fd0df540f6ab99598b21",
  releasePage: "https://github.com/Yangff/RE-UE4SS/releases/tag/linux-experiment",
} as const;

/**
 * The official Windows UE4SS build, for the Wine variant. Under Wine the loader is a
 * proxy DLL (dwmapi.dll) that the game auto-loads from Pal/Binaries/Win64 — no
 * LD_PRELOAD, and DLL-based mods (PalGuard, PalDefender) load normally. Pinned like
 * the Linux asset; bump both fields together.
 */
export const UE4SS_WINDOWS = {
  url: "https://github.com/UE4SS-RE/RE-UE4SS/releases/download/v3.0.1/UE4SS_v3.0.1.zip",
  sha256: "4b47d4bceddd2f561a4e395bfa00924ccfc945af576a2d0c613e6537846c57ec",
  releasePage: "https://github.com/UE4SS-RE/RE-UE4SS/releases/tag/v3.0.1",
} as const;

/** Wine loads UE4SS via this proxy DLL (auto-loaded, no LD_PRELOAD). */
export const PAL_FRAMEWORK_WINE_LOADER = "Pal/Binaries/Win64/dwmapi.dll";

/**
 * Windows system DLL names that proxy-loader mods ship under, dropped next to the
 * server exe. Wine only loads a native (on-disk) DLL over its builtin when that name
 * is listed in WINEDLLOVERRIDES, so each of these works on Windows but sits inert
 * under Wine unless we add an override for it (GH #20 — PalDefender ≥1.5.2 moved its
 * loader to d3d9.dll and stopped loading, while UE4SS's dwmapi.dll kept working only
 * because its override is hardcoded in the spec).
 *
 * The fix is presence-based: buildPalworldWineSpec adds `<name>=n,b` for each of
 * these actually found in Pal/Binaries/Win64 at start. Curated rather than "any
 * .dll in the dir" because the dir legitimately contains DLLs Wine must NOT be told
 * to prefer native for (steam_api64.dll, the vcruntime/msvcp runtimes) and payload
 * DLLs the loader itself loads (PalDefender.dll). "n,b" (native-then-builtin) keeps
 * a broken/removed proxy from taking the server down — Wine falls back to its own.
 *
 * dwmapi (UE4SS) + d3d9 (PalDefender) are the two in the wild today; the rest are
 * the standard proxy names in the UE/ASI modding ecosystem, listed so the next mod
 * that picks one just works. Extend here if one shows up that isn't covered.
 */
export const PAL_WINE_PROXY_DLLS = [
  "dwmapi",
  "d3d9",
  "d3d11",
  "dxgi",
  "version",
  "winmm",
  "winhttp",
  "xinput1_3",
  "dinput8",
  "dsound",
] as const;

/** The proxy-loader DLLs present in a Win64 file listing, in PAL_WINE_PROXY_DLLS
 *  order (deterministic env output). Pure — the fs read lives in the async wrapper. */
export function filterWineProxyDlls(fileNames: string[]): string[] {
  const present = new Set(fileNames.map((f) => f.toLowerCase()));
  return PAL_WINE_PROXY_DLLS.filter((name) => present.has(`${name}.dll`));
}

/**
 * Scan a Wine server's Pal/Binaries/Win64 for proxy-loader DLLs, for the spec
 * builder's WINEDLLOVERRIDES. Best-effort: no dir (fresh instance, game not
 * installed yet) → empty, and the spec still hardcodes dwmapi regardless.
 */
export async function detectPalWineProxyDlls(serverId: string): Promise<string[]> {
  try {
    const dir = join(LocalPaths.instanceRoot(serverId), "Pal/Binaries/Win64");
    return filterWineProxyDlls(await readdir(dir));
  } catch {
    return [];
  }
}

const UE4SS_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Palworld isn't on Steam Workshop, so mods are managed as files in the bind-mounted
 * instance dir: .pak content mods in Pal/Content/Paks/~mods, plus a server-side mod
 * framework (UE4SS).
 *
 * Two variants, chosen by the server's Game:
 *  - PALWORLD (native Linux): the experimental libUE4SS.so in Pal/Binaries/Linux,
 *    loaded via LD_PRELOAD. Only Lua/Blueprint mods load — DLL mods can't enter a
 *    Linux process.
 *  - PALWORLD_WINE (Windows server under Wine): the official UE4SS Windows build in
 *    Pal/Binaries/Win64, auto-loaded by the dwmapi.dll proxy (no LD_PRELOAD). DLL
 *    mods (PalGuard, PalDefender) load normally here.
 */
@Injectable()
export class PalModsService {
  constructor(private readonly prisma: PrismaService) {}

  private async palServer(id: string) {
    const s = await this.prisma.server.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("Server not found");
    if (s.game !== Game.PALWORLD && s.game !== Game.PALWORLD_WINE) {
      throw new BadRequestException("Mod files are Palworld-only here");
    }
    return s;
  }
  private isWine(s: { game: string }): boolean {
    return s.game === Game.PALWORLD_WINE;
  }
  private paksDir(id: string): string {
    return join(LocalPaths.instanceRoot(id), "Pal/Content/Paks/~mods");
  }
  private frameworkDir(id: string, wine: boolean): string {
    return join(LocalPaths.instanceRoot(id), wine ? "Pal/Binaries/Win64" : "Pal/Binaries/Linux");
  }

  async status(id: string) {
    const s = await this.palServer(id);
    const wine = this.isWine(s);
    const cfg = JSON.parse(s.configJson) as ServerConfigValues;
    // Wine auto-loads the dwmapi.dll proxy from Win64; native preloads a configurable
    // .so via LD_PRELOAD.
    const preload = wine
      ? PAL_FRAMEWORK_WINE_LOADER
      : (cfg.values?._palFrameworkPreload as string) || PAL_FRAMEWORK_DEFAULT_PRELOAD;
    let paks: string[] = [];
    try {
      paks = (await readdir(this.paksDir(id))).filter((f) => /\.(pak|ucas|utoc)$/i.test(f));
    } catch {
      /* dir not created yet */
    }
    let present = false;
    try {
      await stat(join(LocalPaths.instanceRoot(id), preload));
      present = true;
    } catch {
      /* framework lib not installed */
    }
    // Under Wine the proxy loads whenever it's present, so presence IS enabled; native
    // gates loading behind the LD_PRELOAD flag written into the spec.
    const enabled = wine ? present : Boolean(cfg.values?._palFramework);
    return { paks, framework: { enabled, preload, present, wine } };
  }

  /** Add a .pak (or .ucas/.utoc, or a .zip of them) to the ~mods folder. */
  async addPak(id: string, filename: string, data: Buffer) {
    await this.palServer(id);
    const safe = basename(filename);
    if (!/\.(pak|ucas|utoc|zip)$/i.test(safe)) {
      throw new BadRequestException("Upload a .pak / .ucas / .utoc (or a .zip containing them)");
    }
    const dir = this.paksDir(id);
    await mkdir(dir, { recursive: true });
    if (/\.zip$/i.test(safe)) await this.extractZip(data, dir);
    else await writeFile(join(dir, safe), data);
    return this.status(id);
  }

  async removePak(id: string, name: string) {
    await this.palServer(id);
    await rm(join(this.paksDir(id), basename(name)), { force: true });
    return this.status(id);
  }

  /** Toggle the mod framework on/off (and its LD_PRELOAD target). Takes effect on
   *  the next start — buildPalworldSpec reads these from config. */
  async setFramework(id: string, opts: { enabled?: boolean; preload?: string }) {
    const s = await this.palServer(id);
    const cfg = JSON.parse(s.configJson) as ServerConfigValues;
    const values: Record<string, unknown> = { ...(cfg.values ?? {}) };
    if (opts.enabled !== undefined) values._palFramework = opts.enabled;
    if (opts.preload !== undefined) {
      values._palFrameworkPreload = opts.preload.trim() || PAL_FRAMEWORK_DEFAULT_PRELOAD;
    }
    await this.prisma.server.update({
      where: { id },
      data: { configJson: JSON.stringify({ ...cfg, values }), configDirty: true },
    });
    return this.status(id);
  }

  /** Install a framework archive (UE4SS) into the game's binaries dir — Pal/Binaries/Linux
   *  for the native build, Pal/Binaries/Win64 for the Wine build. */
  async installFramework(id: string, data: Buffer) {
    const s = await this.palServer(id);
    const dir = this.frameworkDir(id, this.isWine(s));
    await mkdir(dir, { recursive: true });
    await this.extractZip(data, dir);
    await this.makeHeadlessSafe(dir);
    return this.status(id);
  }

  /**
   * UE4SS ships with GuiConsoleEnabled=1 and bUseUObjectArrayCache=true, neither of
   * which suits a headless dedicated server — the GUI console has no display to
   * attach to, and the object-array cache is the documented cause of crashes on
   * Palworld. Flip both after extracting so a fresh install just works.
   */
  private async makeHeadlessSafe(dir: string): Promise<void> {
    const file = join(dir, "UE4SS-settings.ini");
    let ini: string;
    try {
      ini = await readFile(file, "utf8");
    } catch {
      return; // not a UE4SS archive (or a layout we don't recognize) — leave it alone
    }
    // Function replacers, not "$10" — that reads as capture group 10, not group 1
    // followed by a zero.
    const patched = ini
      .replace(/^(\s*GuiConsoleEnabled\s*=\s*).*$/m, (_m, p1: string) => `${p1}0`)
      .replace(/^(\s*bUseUObjectArrayCache\s*=\s*).*$/m, (_m, p1: string) => `${p1}false`);
    if (patched !== ini) await writeFile(file, patched, "utf8");
  }

  /**
   * One-click: fetch the pinned UE4SS Linux build, verify its sha256, extract it
   * into Pal/Binaries/Linux (libUE4SS.so sits at the archive root, so it lands on
   * the default preload path), and enable the framework. Applies on next restart.
   */
  async installFrameworkFromUpstream(id: string) {
    const s = await this.palServer(id);
    const wine = this.isWine(s);
    const asset = wine ? UE4SS_WINDOWS : UE4SS_LINUX;
    const data = await this.download(asset.url);

    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== asset.sha256) {
      // The pinned asset changed under us — refuse rather than load an unknown binary
      // into the game process.
      throw new BadRequestException(
        `UE4SS download failed integrity check (expected ${asset.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…). Install it manually from ${asset.releasePage}.`,
      );
    }

    await this.installFramework(id, data);
    // The archive must actually contain the loader where the game expects it, or the
    // server would start with a dangling loader.
    const loaderRel = wine ? PAL_FRAMEWORK_WINE_LOADER : PAL_FRAMEWORK_DEFAULT_PRELOAD;
    const loader = join(LocalPaths.instanceRoot(id), loaderRel);
    if (!(await stat(loader).then(() => true).catch(() => false))) {
      throw new BadRequestException(
        `Extracted the archive but ${loaderRel} is missing — the release layout may have changed.`,
      );
    }
    // Wine auto-loads the proxy DLL by presence — nothing to flag. Native must set the
    // LD_PRELOAD flag + reset the preload to the default (a stale custom path would
    // silently win over the loader we just installed).
    if (wine) return this.status(id);
    return this.setFramework(id, { enabled: true, preload: PAL_FRAMEWORK_DEFAULT_PRELOAD });
  }

  private async download(url: string): Promise<Buffer> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UE4SS_DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw new BadRequestException(`Could not download UE4SS: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async extractZip(data: Buffer, dest: string) {
    // Untrusted upload / downloaded framework → traversal-safe extraction.
    await extractZipSafe(data, dest);
  }
}
