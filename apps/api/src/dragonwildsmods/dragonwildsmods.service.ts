import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { Game } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LocalPaths } from "../common/paths";
import { extractZipSafe } from "../common/safe-extract";

/** Where the Linux server looks for mods, relative to the instance root. The
 *  folder name is "~mods", tilde included, flat — no subfolders (verified live). */
const DRAGONWILDS_MODS_SUBPATH = "gamefiles/RSDragonwilds/Content/Paks/~mods";

const PARTS = ["pak", "utoc", "ucas"] as const;
type Part = (typeof PARTS)[number];

export interface DragonwildsMod {
  name: string;
  /** Which of .pak/.utoc/.ucas are present. */
  parts: Part[];
  /** All three present. A .pak on its own is found but never mounts (verified live). */
  complete: boolean;
}

/**
 * Dragonwilds mods are Unreal IoStore content: a .pak with a sibling .utoc and
 * .ucas of the same base name, dropped into Content/Paks/~mods. There is no
 * workshop (Nexus Mods only), and UE4SS Lua mods cannot load on the Linux server.
 * This manages the files in the bind-mounted install; they load on the next start.
 */
@Injectable()
export class DragonwildsModsService {
  constructor(private readonly prisma: PrismaService) {}

  private async dragonwildsServer(id: string) {
    const s = await this.prisma.server.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("Server not found");
    if (s.game !== Game.DRAGONWILDS) throw new BadRequestException("Mod files are Dragonwilds-only here");
    return s;
  }

  private modsDir(id: string): string {
    return join(LocalPaths.instanceRoot(id), DRAGONWILDS_MODS_SUBPATH);
  }

  async status(id: string): Promise<{ mods: DragonwildsMod[] }> {
    await this.dragonwildsServer(id);
    let files: string[] = [];
    try {
      files = await readdir(this.modsDir(id));
    } catch {
      /* dir not created yet */
    }
    return { mods: groupModFiles(files) };
  }

  /** Add a .pak/.utoc/.ucas (or a .zip of them) to the ~mods folder. */
  async addFile(id: string, filename: string, data: Buffer) {
    await this.dragonwildsServer(id);
    const safe = basename(filename);
    if (!/\.(pak|utoc|ucas|zip)$/i.test(safe)) {
      throw new BadRequestException("Upload the mod's .pak, .utoc and .ucas files (or a .zip containing them)");
    }
    const dir = this.modsDir(id);
    await mkdir(dir, { recursive: true });
    // Untrusted upload → traversal-safe extraction (rejects ../ + absolute, strips symlinks).
    if (/\.zip$/i.test(safe)) await extractZipSafe(data, dir);
    else await writeFile(join(dir, safe), data);
    return this.status(id);
  }

  /** Remove every part of a mod by base name. */
  async removeMod(id: string, name: string) {
    await this.dragonwildsServer(id);
    const base = basename(name);
    await Promise.all(PARTS.map((p) => rm(join(this.modsDir(id), `${base}.${p}`), { force: true })));
    return this.status(id);
  }
}

/** Fold a flat file listing into mods keyed by base name, with the parts each has. */
export function groupModFiles(files: string[]): DragonwildsMod[] {
  const byName = new Map<string, Set<Part>>();
  for (const f of files) {
    const m = f.match(/^(.+)\.(pak|utoc|ucas)$/i);
    if (!m) continue;
    const parts = byName.get(m[1]!) ?? new Set<Part>();
    parts.add(m[2]!.toLowerCase() as Part);
    byName.set(m[1]!, parts);
  }
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, set]) => {
      const parts = PARTS.filter((p) => set.has(p));
      return { name, parts, complete: parts.length === PARTS.length };
    });
}
