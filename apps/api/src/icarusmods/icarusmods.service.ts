import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Game } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LocalPaths } from "../common/paths";

const execFileP = promisify(execFile);

/** Where the mornedhels image expects Icarus mods, relative to the instance root
 *  (the game files are bound under gamefiles/; the server install lives at
 *  gamefiles/server/Icarus). Confirmed against a real install. */
const ICARUS_MODS_SUBPATH = "gamefiles/server/Icarus/Content/Paks/mods";

/**
 * Icarus mods aren't on Steam Workshop — they're Unreal .pak files from the
 * community (NexusMods / Project Daedalus). This manages them as files in the
 * bind-mounted install: uploads land in Icarus/Content/Paks/mods and load on the
 * next start. Note two Icarus quirks the UI surfaces: every connecting player needs
 * the same mods, and multiple mods must be merged into one ._P.pak beforehand.
 */
@Injectable()
export class IcarusModsService {
  constructor(private readonly prisma: PrismaService) {}

  private async icarusServer(id: string) {
    const s = await this.prisma.server.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("Server not found");
    if (s.game !== Game.ICARUS) throw new BadRequestException("Mod files are Icarus-only here");
    return s;
  }

  private modsDir(id: string): string {
    return join(LocalPaths.instanceRoot(id), ICARUS_MODS_SUBPATH);
  }

  async status(id: string) {
    await this.icarusServer(id);
    let paks: string[] = [];
    try {
      paks = (await readdir(this.modsDir(id))).filter((f) => /\.(pak|ucas|utoc)$/i.test(f));
    } catch {
      /* dir not created yet */
    }
    return { paks };
  }

  /** Add a .pak (or .ucas/.utoc, or a .zip of them) to the Paks/mods folder. */
  async addPak(id: string, filename: string, data: Buffer) {
    await this.icarusServer(id);
    const safe = basename(filename);
    if (!/\.(pak|ucas|utoc|zip)$/i.test(safe)) {
      throw new BadRequestException("Upload a .pak / .ucas / .utoc (or a .zip containing them)");
    }
    const dir = this.modsDir(id);
    await mkdir(dir, { recursive: true });
    if (/\.zip$/i.test(safe)) await this.extractZip(data, dir);
    else await writeFile(join(dir, safe), data);
    return this.status(id);
  }

  async removePak(id: string, name: string) {
    await this.icarusServer(id);
    await rm(join(this.modsDir(id), basename(name)), { force: true });
    return this.status(id);
  }

  private async extractZip(data: Buffer, dest: string) {
    const tmp = join(tmpdir(), `icarusmod-upload-${process.pid}-${Date.now()}.zip`);
    await writeFile(tmp, data);
    try {
      await execFileP("unzip", ["-o", tmp, "-d", dest]);
    } catch (e) {
      throw new BadRequestException(`Could not unzip the upload: ${(e as Error).message}`);
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
