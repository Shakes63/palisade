import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename, dirname, relative } from "node:path";
import { Game, type ServerConfigValues } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LocalPaths } from "../common/paths";
import { extractZipSafe, listZipEntries } from "../common/safe-extract";
import { canonicalRoot, resolveSafe } from "../common/safe-path";


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
 * Why an uploaded framework archive is for the wrong Palworld variant, or null when
 * it looks right (or unfamiliar enough that we shouldn't judge).
 *
 * The two builds are not interchangeable: the Wine variant loads a Windows
 * dwmapi.dll proxy out of Pal/Binaries/Win64, the native one preloads libUE4SS.so
 * from Pal/Binaries/Linux. Uploading the wrong one used to extract happily and then
 * do nothing at all — no loader, no UE4SS.log, no error, a server that just boots
 * vanilla (GH #48). The one-click install always picks correctly; this is for the
 * "upload a different build" path beside it.
 *
 * Deliberately narrow: it only objects when the archive carries the OTHER variant's
 * loader and not the expected one. An unusual-but-valid layout still goes through,
 * which matches how the rest of this file treats archives it doesn't recognise.
 */
export function frameworkArchiveIssue(entries: string[], wine: boolean): string | null {
  const has = (needle: string) =>
    entries.some((e) => e.split(/[\\/]/).pop()?.toLowerCase() === needle);
  const windows = has("dwmapi.dll");
  const linux = has("libue4ss.so");

  if (wine && linux && !windows) {
    return (
      "That looks like the native Linux UE4SS build (it contains libUE4SS.so). The Wine " +
      "variant loads a Windows dwmapi.dll proxy instead, so this would extract and then " +
      "never load. Use the official UE4SS Windows build — the Install button above fetches " +
      "the right one."
    );
  }
  if (!wine && windows && !linux) {
    return (
      "That looks like the Windows UE4SS build (it contains dwmapi.dll). The native Linux " +
      "variant preloads libUE4SS.so instead, so this would extract and then never load. " +
      "Use a native Linux build — the Install button above fetches the right one."
    );
  }
  return null;
}

/**
 * PalSchema (Okaetsu/PalSchema): a UE4SS logic mod that lets JSON-based content mods
 * (new Pals, items, recipes) load without writing a Blueprint mod. It's a Windows DLL
 * loaded by UE4SS itself, so it only runs under the Wine variant, and needs UE4SS
 * installed first. Its release zip's root IS the "PalSchema" folder UE4SS expects
 * under Mods/, so it extracts straight into UE4SS's Mods dir. Pinned like the UE4SS
 * assets above (verified against the actual downloaded asset, not just its docs);
 * bump both fields together.
 */
export const PALSCHEMA = {
  url: "https://github.com/Okaetsu/PalSchema/releases/download/0.6.5/PalSchema_0.6.5.zip",
  sha256: "d8ef2758a696c017751b479c7dd0cf40c1c772ee68049501f846754fa4f0307d",
  releasePage: "https://github.com/Okaetsu/PalSchema/releases/tag/0.6.5",
} as const;

/** Where PalSchema's loader DLL ends up once installed under UE4SS's Mods folder —
 *  used both to detect "is it installed" and to sanity-check an upload/download. */
export const PAL_SCHEMA_DLL = "Pal/Binaries/Win64/Mods/PalSchema/dlls/main.dll";

/**
 * UE4SS starts a C++/DLL mod when its folder contains an `enabled.txt` marker —
 * verified against a live server, whose UE4SS.log reads
 * "Mod 'PalSchema' has enabled.txt, starting mod." while PalSchema is absent
 * from Mods/mods.txt entirely.
 *
 * mods.txt is the OTHER, Lua-mod enable list (`Name : 1`/`0`); writing a
 * PalSchema entry there does nothing. The release zip already ships this
 * marker, so a clean install needs no help — we only recreate it if a
 * hand-rolled archive left it out.
 */
export const PAL_SCHEMA_ENABLED_MARKER = "Pal/Binaries/Win64/Mods/PalSchema/enabled.txt";

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

/** Files a PalSchema mod is allowed to carry as editable config. */
const PAL_SCHEMA_CONFIG_EXT = /\.jsonc?$/i;

/** Archive noise that is never part of a mod. */
const ARCHIVE_JUNK = /^__MACOSX\/|(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$/i;

/** Where a mod folder lands, and which directory inside the archive holds it. */
export interface PalSchemaModPlan {
  /** Folder name under Mods/PalSchema/mods. */
  name: string;
  /** Directory inside the extracted archive to move there ("" = the archive root). */
  from: string;
}

/**
 * Work out where a PalSchema mod's files actually live inside an uploaded archive.
 *
 * Authors package these four ways in the wild (all four are in our samples):
 *   1. `ModName/blueprints/x.jsonc`                            — bare mod folder
 *   2. `ModName/raw/x.json` + `ModName/README.txt`             — same, with docs
 *   3. `Mods/PalSchema/mods/ModName/items/x.jsonc`             — partial game path
 *   4. `Pal/Binaries/Win64/ue4ss/Mods/PalSchema/mods/ModName/` — full game path
 *
 * Extracting the archive verbatim into Mods/PalSchema/mods (what we used to do) only
 * works for 1 and 2. For 3 and 4 it produced a nested `mods/Mods/PalSchema/mods/...`
 * that PalSchema never looks at, so the upload "succeeded" into a mod that silently
 * did nothing. Note #4 also proves the prefix can't be hardcoded: that author packaged
 * for UE4SS's newer `ue4ss/Mods` layout while this server uses `Win64/Mods`.
 *
 * So: find the `PalSchema/mods/<ModName>` marker anywhere in the tree and take what's
 * under it. Failing that, treat each top-level folder holding JSON as a mod. Failing
 * that, a flat archive of JSON becomes one mod named after the upload.
 */
export function planPalSchemaMods(paths: string[], fallbackName: string): PalSchemaModPlan[] {
  const files = paths
    .map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((p) => p && !p.endsWith("/") && !ARCHIVE_JUNK.test(p));

  const add = (out: PalSchemaModPlan[], plan: PalSchemaModPlan) => {
    if (!out.some((e) => e.from === plan.from)) out.push(plan);
  };

  // 1+2. The explicit marker, wherever it sits in the path.
  const marked: PalSchemaModPlan[] = [];
  for (const f of files) {
    const segs = f.split("/");
    const i = segs.findIndex(
      (seg, n) =>
        seg.toLowerCase() === "palschema" &&
        segs[n + 1]?.toLowerCase() === "mods" &&
        Boolean(segs[n + 2]),
    );
    // The marker must have a file BELOW the mod folder, or it's the folder entry itself.
    const name = i >= 0 ? segs[i + 2] : undefined;
    if (name && segs.length > i + 3) {
      add(marked, { name, from: segs.slice(0, i + 3).join("/") });
    }
  }
  if (marked.length) return marked;

  // 3. Top-level folders that carry JSON. A folder of only docs/images isn't a mod.
  const tops: PalSchemaModPlan[] = [];
  for (const f of files) {
    const segs = f.split("/");
    const top = segs[0];
    if (segs.length < 2 || !top || !PAL_SCHEMA_CONFIG_EXT.test(f)) continue;
    add(tops, { name: top, from: top });
  }
  if (tops.length) return tops;

  // 4. A flat archive of JSON — name the mod after the upload.
  if (files.some((f) => !f.includes("/") && PAL_SCHEMA_CONFIG_EXT.test(f))) {
    return [{ name: fallbackName, from: "" }];
  }
  return [];
}

/** File extensions that make up an Unreal pak content mod. */
const PAK_EXT = /\.(pak|ucas|utoc)$/i;

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
  private ue4ssModsDir(id: string): string {
    return join(this.frameworkDir(id, true), "Mods");
  }
  private palSchemaDir(id: string): string {
    return join(this.ue4ssModsDir(id), "PalSchema");
  }
  private palSchemaContentDir(id: string): string {
    return join(this.palSchemaDir(id), "mods");
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
      // Recursive on purpose. Mod zips almost always ship a `ModName/` folder holding
      // the .pak/.ucas/.utoc trio, and Unreal mounts those fine from a subfolder — but
      // a flat readdir saw only the folder NAME, which fails the extension filter. The
      // upload silently "succeeded" into a mod the panel could neither show nor delete.
      // Entries come back relative to the ~mods dir, so they double as delete handles.
      const entries = await readdir(this.paksDir(id), { recursive: true });
      paks = entries.filter((f) => PAK_EXT.test(f)).sort();
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

    // PalSchema is a Windows UE4SS mod, so it only exists on the Wine variant.
    let palschema: { installed: boolean; enabled: boolean; mods: string[] } | undefined;
    if (wine) {
      const installed = await stat(join(LocalPaths.instanceRoot(id), PAL_SCHEMA_DLL))
        .then(() => true)
        .catch(() => false);
      // UE4SS only starts a DLL mod whose folder has enabled.txt — a hand-installed
      // copy can be present but inert.
      const enabled = await stat(join(LocalPaths.instanceRoot(id), PAL_SCHEMA_ENABLED_MARKER))
        .then(() => true)
        .catch(() => false);
      let mods: string[] = [];
      try {
        mods = (await readdir(this.palSchemaContentDir(id), { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch {
        /* dir not created yet */
      }
      palschema = { installed, enabled, mods };
    }

    return { paks, framework: { enabled, preload, present, wine }, palschema };
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

  /**
   * Remove one pak file. `name` is the path RELATIVE to ~mods as listed by status(),
   * so it may contain a mod subfolder — hence the shared resolveSafe() guard rather
   * than a basename() strip, which would have silently missed nested files.
   *
   * Same containment check the file manager uses: lexical escapes, absolute paths and
   * null bytes are rejected, and the deepest existing ancestor is canonicalized so a
   * symlinked mod folder can't aim the delete outside the instance dir.
   */
  async removePak(id: string, name: string) {
    await this.palServer(id);
    const root = await canonicalRoot(this.paksDir(id));
    if (!root) return this.status(id); // no ~mods dir yet, so nothing to remove
    const target = await resolveSafe(root, name);
    // resolveSafe permits the root itself (a listing of "." needs that); the
    // extension check is what keeps this to actual pak files.
    if (!PAK_EXT.test(target)) {
      throw new BadRequestException("Not a pak file inside this server's mod folder");
    }
    await rm(target, { force: true });
    // Drop the mod's folder once its last file is gone; rmdir only succeeds when the
    // dir is already empty, so a mod with files left standing is untouched.
    const parent = dirname(target);
    if (parent !== root) await rmdir(parent).catch(() => undefined);
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
    const wine = this.isWine(s);
    // Check the archive is for THIS variant before writing any of it: the wrong build
    // extracts cleanly and then silently never loads (GH #48).
    const issue = frameworkArchiveIssue(await listZipEntries(data), wine);
    if (issue) throw new BadRequestException(issue);
    const dir = this.frameworkDir(id, wine);
    await mkdir(dir, { recursive: true });
    // UE4SS's archive ships its own Mods/mods.txt (the Lua-mod enable list), so
    // extracting over an existing install replaces whatever the operator set there.
    // That matters: PalSchema's install docs have you DISABLE CheatManagerEnablerMod
    // and ConsoleCommandsMod to avoid crashes, and UE4SS's shipped default turns
    // them back on. Restore the existing file after extracting.
    const modsTxt = join(dir, "Mods", "mods.txt");
    const existingModsTxt = await readFile(modsTxt, "utf8").catch(() => null);
    await this.extractZip(data, dir);
    if (existingModsTxt !== null) await writeFile(modsTxt, existingModsTxt, "utf8");
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

  /**
   * One-click: fetch the pinned PalSchema build, verify its sha256, and extract it
   * into UE4SS's Mods folder (its zip root IS the "PalSchema" folder UE4SS expects).
   * Gated on UE4SS being installed — checked BEFORE the download, so a server
   * missing the framework fails instantly instead of after a 60s fetch.
   */
  async installPalSchemaFromUpstream(id: string) {
    await this.requirePalSchemaReady(id);
    const data = await this.download(PALSCHEMA.url);

    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== PALSCHEMA.sha256) {
      throw new BadRequestException(
        `PalSchema download failed integrity check (expected ${PALSCHEMA.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…). Install it manually from ${PALSCHEMA.releasePage}.`,
      );
    }
    return this.installPalSchema(id, data);
  }

  /** Install a PalSchema build (from upstream or a manual upload) into UE4SS's Mods
   *  folder, then make sure UE4SS will actually start it. */
  async installPalSchema(id: string, data: Buffer) {
    await this.requirePalSchemaReady(id);
    const dir = this.ue4ssModsDir(id);
    await mkdir(dir, { recursive: true });
    await this.extractZip(data, dir);
    const dllPath = join(LocalPaths.instanceRoot(id), PAL_SCHEMA_DLL);
    if (!(await stat(dllPath).then(() => true).catch(() => false))) {
      throw new BadRequestException(
        `Extracted the archive but ${PAL_SCHEMA_DLL} is missing — is this actually a PalSchema release zip?`,
      );
    }
    // The release zip ships enabled.txt; recreate it only if a custom archive didn't.
    const marker = join(LocalPaths.instanceRoot(id), PAL_SCHEMA_ENABLED_MARKER);
    if (!(await stat(marker).then(() => true).catch(() => false))) {
      await writeFile(marker, "", "utf8");
    }
    return this.status(id);
  }

  /** Add a PalSchema content mod — its own .zip, whose folder lands under
   *  Mods/PalSchema/mods, the same layout PalSchema itself expects. */
  async addPalSchemaMod(id: string, filename: string, data: Buffer) {
    await this.requirePalSchemaReady(id);
    if (!/\.zip$/i.test(basename(filename))) {
      throw new BadRequestException("Upload the mod's .zip — its folder goes into Mods/PalSchema/mods");
    }
    // Content mods are loaded BY PalSchema, so it has to be there too — not just UE4SS.
    const installed = await stat(join(LocalPaths.instanceRoot(id), PAL_SCHEMA_DLL)).then(() => true).catch(() => false);
    if (!installed) throw new BadRequestException("Install PalSchema first — it's what loads these mods.");

    const dir = this.palSchemaContentDir(id);
    await mkdir(dir, { recursive: true });
    // Extract to a staging dir FIRST and move the mod folder out of it, because the
    // archive's own layout decides where the files are (see planPalSchemaMods). Staging
    // lives beside the instance rather than in /tmp so the move is a same-filesystem
    // rename instead of a copy.
    const staging = join(LocalPaths.instanceRoot(id), `.palschema-upload-${process.pid}-${Date.now()}`);
    await mkdir(staging, { recursive: true });
    try {
      await this.extractZip(data, staging);
      const plans = planPalSchemaMods(await listZipEntries(data), basename(filename, ".zip"));
      if (plans.length === 0) {
        throw new BadRequestException(
          "No PalSchema mod found in that archive — expected a mod folder with .json/.jsonc files " +
            "(optionally nested under Mods/PalSchema/mods). Is this a pak mod? Those go in the Pak mods section above.",
        );
      }
      for (const plan of plans) {
        const src = plan.from ? join(staging, plan.from) : staging;
        const dest = join(dir, plan.name);
        // Replace wholesale so re-uploading a newer build can't leave stale files from
        // the old one behind.
        await rm(dest, { recursive: true, force: true });
        await rename(src, dest);
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    return this.status(id);
  }

  /**
   * The .json/.jsonc files inside one installed mod, as paths RELATIVE TO THE INSTANCE
   * ROOT — which is exactly what the file-manager read/write endpoints take, so the
   * config editor needs no read/write routes of its own.
   *
   * Mods nest these several levels deep (translations/<lang>/x.jsonc), so the walk is
   * recursive. Directories are skipped; so is anything that isn't JSON, since the point
   * is editing config rather than browsing the mod.
   */
  async palSchemaModConfigFiles(id: string, name: string): Promise<{ files: string[] }> {
    await this.palServer(id);
    const modsDir = this.palSchemaContentDir(id);
    const root = await canonicalRoot(modsDir);
    if (!root) return { files: [] };
    const dir = await resolveSafe(root, name);
    if (dir === root) throw new BadRequestException("Missing mod name");
    const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
    const instance = join(LocalPaths.instanceRoot(id));
    const files = entries
      .map((e) => e.replace(/\\/g, "/"))
      .filter((e) => PAL_SCHEMA_CONFIG_EXT.test(e))
      .map((e) => relative(instance, join(dir, e)))
      .sort();
    return { files };
  }

  /**
   * Remove one installed PalSchema mod, folder and all.
   *
   * Uses the shared resolveSafe() like every other client-path route here, rather than
   * the basename() strip it used to: a basename quietly rewrites an escape attempt into
   * some other name and deletes whatever that happens to hit, where this refuses it
   * outright. Requiring the target's parent to BE the mods dir keeps the old
   * one-folder-only semantics explicit — this deletes a mod, not a file inside one.
   *
   * Deliberately not gated on requirePalSchemaReady(): cleaning up after a broken or
   * half-removed install has to work even when UE4SS is gone.
   */
  async removePalSchemaMod(id: string, name: string) {
    await this.palServer(id);
    const root = await canonicalRoot(this.palSchemaContentDir(id));
    if (!root) return this.status(id); // no mods dir yet, so nothing to remove
    const target = await resolveSafe(root, name);
    if (target === root || dirname(target) !== root) {
      throw new BadRequestException("Not an installed PalSchema mod");
    }
    await rm(target, { recursive: true, force: true });
    return this.status(id);
  }

  /**
   * Shared precondition for every PalSchema WRITE path. Two gates:
   *  - Wine variant only. PalSchema is a Windows DLL; the native Linux server
   *    can't load it at all.
   *  - UE4SS must already be installed. PalSchema is a UE4SS mod — without the
   *    framework its files sit inert in Mods/ and never load, which looks
   *    identical to a working install until you read UE4SS.log.
   *
   * Enforced here rather than only by disabling buttons, so a direct API call
   * (or a stale tab whose status predates a framework wipe) can't slip past it.
   * Deliberately NOT applied to removal — cleaning up a broken install should
   * always work.
   */
  private async requirePalSchemaReady(id: string): Promise<void> {
    const s = await this.palServer(id);
    if (!this.isWine(s)) {
      throw new BadRequestException("PalSchema is a Windows UE4SS mod — it needs the Palworld (Wine) variant");
    }
    const ue4ss = await stat(join(LocalPaths.instanceRoot(id), PAL_FRAMEWORK_WINE_LOADER))
      .then(() => true)
      .catch(() => false);
    if (!ue4ss) {
      throw new BadRequestException(
        "Install the UE4SS framework first — PalSchema is a UE4SS mod and can't load without it.",
      );
    }
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
