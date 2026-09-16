import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { join, dirname, basename } from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { PrismaService } from "../prisma/prisma.service";
import { LocalPaths } from "../common/paths";
import { resolveSafe } from "../common/safe-path";

/** Max size the in-browser text editor will open/save (bigger files → download). */
export const EDIT_MAX_BYTES = 2 * 1024 * 1024;
/** Directory listings are capped so a 100k-file mod dir can't melt the browser. */
const LIST_MAX_ENTRIES = 2000;

export interface FileEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: string;
}

/**
 * Per-server file manager over the instance directory (game files, saves, configs).
 * The security core is the shared {@link resolveSafe}: every path from the client is
 * treated as hostile — it must resolve INSIDE the server's instance root after lexical
 * normalization and symlink resolution, so neither `../` tricks nor symlinks planted
 * by a game/mod can reach the host filesystem. Everything else is plain fs.
 */
@Injectable()
export class FilesService {
  constructor(private readonly prisma: PrismaService) {}

  private async root(serverId: string): Promise<string> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    const root = LocalPaths.instanceRoot(serverId);
    await mkdir(root, { recursive: true });
    // Canonicalize once so containment checks compare like with like.
    return realpath(root);
  }


  async list(serverId: string, rel: string): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
    const root = await this.root(serverId);
    const dir = await resolveSafe(root, rel || ".");
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new BadRequestException("Not a directory");
    const names = await readdir(dir, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of names.slice(0, LIST_MAX_ENTRIES)) {
      const s = await stat(join(dir, d.name)).catch(() => null);
      if (!s) continue; // vanished/broken symlink → skip
      entries.push({
        name: d.name,
        type: s.isDirectory() ? "dir" : "file",
        size: s.isDirectory() ? 0 : s.size,
        modifiedAt: s.mtime.toISOString(),
      });
    }
    entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    return { path: rel || ".", entries, truncated: names.length > LIST_MAX_ENTRIES };
  }

  /** Text content for the editor, or a refusal for big/binary files. */
  async readText(serverId: string, rel: string): Promise<{ path: string; content: string }> {
    const root = await this.root(serverId);
    const file = await resolveSafe(root, rel);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) throw new BadRequestException("Not a file");
    if (st.size > EDIT_MAX_BYTES) {
      throw new BadRequestException(`File is too large to edit in the browser (limit ${EDIT_MAX_BYTES / 1024 / 1024} MB) — use Download.`);
    }
    const buf = await readFile(file);
    if (buf.subarray(0, 8000).includes(0)) {
      throw new BadRequestException("Binary file — use Download instead.");
    }
    return { path: rel, content: buf.toString("utf8") };
  }

  async writeText(serverId: string, rel: string, content: string): Promise<{ ok: true }> {
    if (Buffer.byteLength(content, "utf8") > EDIT_MAX_BYTES) {
      throw new BadRequestException("Content exceeds the editor size limit");
    }
    const root = await this.root(serverId);
    const file = await resolveSafe(root, rel);
    const st = await stat(file).catch(() => null);
    if (st && !st.isFile()) throw new BadRequestException("Not a file");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return { ok: true };
  }

  /** Absolute path for a streamed download (controller pipes it). */
  async downloadPath(serverId: string, rel: string): Promise<{ file: string; name: string; size: number }> {
    const root = await this.root(serverId);
    const file = await resolveSafe(root, rel);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) throw new BadRequestException("Not a file");
    return { file, name: basename(file), size: st.size };
  }

  async upload(serverId: string, relDir: string, filename: string, data: Buffer): Promise<{ ok: true }> {
    // The filename comes from the browser — keep only its basename, drop path tricks.
    const name = basename(filename).replace(/[\0/\\]/g, "");
    if (!name || name === "." || name === "..") throw new BadRequestException("Invalid file name");
    const root = await this.root(serverId);
    const dir = await resolveSafe(root, relDir || ".");
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new BadRequestException("Destination is not a directory");
    await writeFile(await resolveSafe(root, join(relDir || ".", name)), data);
    return { ok: true };
  }

  async mkdir(serverId: string, rel: string): Promise<{ ok: true }> {
    const root = await this.root(serverId);
    const dir = await resolveSafe(root, rel);
    await mkdir(dir, { recursive: true });
    return { ok: true };
  }

  async rename(serverId: string, fromRel: string, toRel: string): Promise<{ ok: true }> {
    const root = await this.root(serverId);
    const from = await resolveSafe(root, fromRel);
    const to = await resolveSafe(root, toRel);
    if (from === root || to === root) throw new BadRequestException("Cannot rename the server root");
    await rename(from, to);
    return { ok: true };
  }

  async remove(serverId: string, rel: string): Promise<{ ok: true }> {
    const root = await this.root(serverId);
    const target = await resolveSafe(root, rel);
    if (target === root) throw new BadRequestException("Cannot delete the server root");
    await rm(target, { recursive: true, force: true });
    return { ok: true };
  }
}
