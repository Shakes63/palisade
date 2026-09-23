import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { Game, type ServerConfigValues } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LocalPaths } from "../common/paths";
import { extractZipSafe } from "../common/safe-extract";


/** Thunderstore's Valheim package index (full community dump). Cached in memory. */
const THUNDERSTORE_INDEX_URL = "https://thunderstore.io/c/valheim/api/v1/package/";
const INDEX_TTL_MS = 60 * 60 * 1000; // refresh hourly
const PAGE_SIZE = 20;

/** BepInEx mod plugins live here (relative to the instance root). The lloesche image
 *  mounts config at /config, so plugins are at config/bepinex/plugins; BepInEx scans
 *  this tree recursively for .dll plugins on start. */
const VALHEIM_PLUGINS_SUBPATH = "config/bepinex/plugins";

/** A slimmed Thunderstore package (the fields the UI + installer need). */
interface TsPackage {
  name: string;
  fullName: string; // "Owner-ModName"
  owner: string;
  description: string;
  icon: string;
  versionNumber: string;
  downloadUrl: string;
  downloads: number;
  rating: number;
  categories: string[];
  deprecated: boolean;
  packageUrl: string;
  dependencies: string[]; // "Owner-ModName-1.2.3"
}

/** Names that the lloesche image already provides via BEPINEX=true — never install. */
const PROVIDED_DEPS = /bepinexpack/i;

/**
 * Valheim mod browser backed by Thunderstore (the Valheim mod database). Search hits
 * a cached copy of the community package index; installing downloads the mod's zip
 * (and its Thunderstore dependencies) and extracts each into config/bepinex/plugins,
 * where BepInEx loads them on the next start. Installing anything auto-enables the
 * BEPINEX setting so the framework is actually present.
 */
@Injectable()
export class ValheimModsService {
  private readonly logger = new Logger(ValheimModsService.name);
  private index: { at: number; byFullName: Map<string, TsPackage>; list: TsPackage[] } | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private async valheimServer(id: string) {
    const s = await this.prisma.server.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("Server not found");
    if (s.game !== Game.VALHEIM) throw new BadRequestException("Thunderstore mods are Valheim-only here");
    return s;
  }

  private pluginsDir(id: string): string {
    return join(LocalPaths.instanceRoot(id), VALHEIM_PLUGINS_SUBPATH);
  }

  // ── Thunderstore index (cached) ──────────────────────────────────────────────
  private async ensureIndex(): Promise<void> {
    if (this.index && Date.now() - this.index.at < INDEX_TTL_MS) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.refreshIndex().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async refreshIndex(): Promise<void> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(THUNDERSTORE_INDEX_URL, { signal: controller.signal });
      if (!res.ok) throw new Error(`Thunderstore ${res.status}`);
      const raw = (await res.json()) as ThunderstoreRaw[];
      const list: TsPackage[] = [];
      const byFullName = new Map<string, TsPackage>();
      for (const p of raw) {
        const v = p.versions?.[0];
        if (!v) continue;
        const pkg: TsPackage = {
          name: p.name,
          fullName: p.full_name,
          owner: p.owner,
          description: v.description ?? "",
          icon: v.icon ?? "",
          versionNumber: v.version_number ?? "",
          downloadUrl: v.download_url ?? "",
          downloads: (p.versions ?? []).reduce((s, x) => s + (x.downloads ?? 0), 0),
          rating: p.rating_score ?? 0,
          categories: p.categories ?? [],
          deprecated: !!p.is_deprecated,
          packageUrl: p.package_url ?? "",
          dependencies: v.dependencies ?? [],
        };
        list.push(pkg);
        byFullName.set(pkg.fullName, pkg);
      }
      this.index = { at: Date.now(), byFullName, list };
      this.logger.log(`Thunderstore index loaded: ${list.length} Valheim packages`);
    } finally {
      clearTimeout(t);
    }
  }

  /** Search the Valheim package index (name/owner/description), most-downloaded first. */
  async search(query: string, page = 0) {
    await this.ensureIndex();
    const idx = this.index!;
    const q = query.trim().toLowerCase();
    let hits = idx.list.filter((p) => !p.deprecated);
    if (q) {
      hits = hits.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.owner.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q),
      );
    }
    hits.sort((a, b) => b.downloads - a.downloads);
    const start = page * PAGE_SIZE;
    const pageItems = hits.slice(start, start + PAGE_SIZE).map(publicView);
    return { total: hits.length, page, pageSize: PAGE_SIZE, results: pageItems };
  }

  // ── Install / manage ─────────────────────────────────────────────────────────
  /** Installed mods with their versions and whether Thunderstore has a newer one.
   *  Installed version comes from each mod folder's manifest.json (shipped in every
   *  Thunderstore zip); latest comes from the cached index. */
  async status(id: string) {
    await this.valheimServer(id);
    let names: string[] = [];
    try {
      const entries = await readdir(this.pluginsDir(id), { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      /* not created yet */
    }
    // Best-effort index for latest versions — an offline Thunderstore must not
    // break the installed list.
    await this.ensureIndex().catch(() => undefined);
    const mods = await Promise.all(
      names.map(async (name) => {
        let installedVersion: string | null = null;
        try {
          const manifest = JSON.parse(
            // Windows-built mods often ship the manifest with a UTF-8 BOM.
            (await readFile(join(this.pluginsDir(id), name, "manifest.json"), "utf8")).replace(/^\uFEFF/, ""),
          ) as { version_number?: string };
          installedVersion = manifest.version_number ?? null;
        } catch {
          /* hand-dropped mod without a manifest */
        }
        const latest = this.index?.byFullName.get(name)?.versionNumber ?? null;
        return {
          name,
          installedVersion,
          latestVersion: latest,
          updateAvailable: Boolean(installedVersion && latest && installedVersion !== latest),
        };
      }),
    );
    return { mods };
  }

  /** Install a package (by "Owner-ModName") and its Thunderstore dependencies. */
  async install(id: string, fullName: string) {
    await this.valheimServer(id);
    await this.ensureIndex();
    const root = this.index!.byFullName.get(fullName);
    if (!root) throw new NotFoundException(`Mod "${fullName}" not found on Thunderstore`);

    const toInstall = this.resolve(root);
    const dir = this.pluginsDir(id);
    await mkdir(dir, { recursive: true });
    for (const pkg of toInstall) {
      await this.installOne(pkg, dir);
    }
    await this.enableBepInEx(id);
    return this.status(id);
  }

  async remove(id: string, name: string) {
    await this.valheimServer(id);
    await rm(join(this.pluginsDir(id), basename(name)), { recursive: true, force: true });
    return this.status(id);
  }

  /** The package + its (transitive) Thunderstore dependencies, minus the BepInExPack
   *  the image already provides. Deduped; missing deps are skipped (logged). */
  private resolve(root: TsPackage): TsPackage[] {
    const out = new Map<string, TsPackage>();
    const visit = (pkg: TsPackage) => {
      if (out.has(pkg.fullName)) return;
      out.set(pkg.fullName, pkg);
      for (const dep of pkg.dependencies) {
        if (PROVIDED_DEPS.test(dep)) continue;
        const depFull = dep.split("-").slice(0, -1).join("-"); // drop the trailing version
        const depPkg = this.index!.byFullName.get(depFull);
        if (depPkg) visit(depPkg);
        else this.logger.warn(`Thunderstore dep not found, skipping: ${dep}`);
      }
    };
    visit(root);
    return [...out.values()];
  }

  private async installOne(pkg: TsPackage, pluginsDir: string) {
    if (!pkg.downloadUrl) throw new BadRequestException(`"${pkg.fullName}" has no downloadable version`);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 60_000);
    let buf: Buffer;
    try {
      const res = await fetch(pkg.downloadUrl, { signal: controller.signal });
      if (!res.ok) throw new Error(`download ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw new BadRequestException(`Failed to download ${pkg.fullName}: ${(e as Error).message}`);
    } finally {
      clearTimeout(t);
    }
    // Each mod gets its own folder so it can be removed cleanly. BepInEx scans
    // plugins/ recursively, so the manifest/readme/icon alongside the .dll are fine.
    const dest = join(pluginsDir, pkg.fullName);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    // Thunderstore zips are untrusted internet content → traversal-safe extraction.
    await extractZipSafe(buf, dest);
  }

  /** Flip the server's BEPINEX catalog setting on so the framework loads the mods. */
  private async enableBepInEx(id: string) {
    const server = await this.prisma.server.findUnique({ where: { id }, select: { configJson: true } });
    if (!server) return;
    const config = JSON.parse(server.configJson) as ServerConfigValues;
    config.values = { ...(config.values ?? {}), BEPINEX: true, VALHEIM_PLUS: false };
    await this.prisma.server.update({ where: { id }, data: { configJson: JSON.stringify(config) } });
  }
}

/** The public shape returned to the browser (drops internal-only fields). */
function publicView(p: TsPackage) {
  return {
    name: p.name,
    fullName: p.fullName,
    owner: p.owner,
    description: p.description,
    icon: p.icon,
    versionNumber: p.versionNumber,
    downloads: p.downloads,
    rating: p.rating,
    categories: p.categories,
    packageUrl: p.packageUrl,
  };
}

// The subset of Thunderstore's v1 package JSON we read.
interface ThunderstoreRaw {
  name: string;
  full_name: string;
  owner: string;
  package_url?: string;
  rating_score?: number;
  is_deprecated?: boolean;
  categories?: string[];
  versions?: {
    description?: string;
    icon?: string;
    version_number?: string;
    download_url?: string;
    downloads?: number;
    dependencies?: string[];
  }[];
}
