import { BadRequestException } from "@nestjs/common";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

/**
 * Safe extraction for UNTRUSTED archives — mod zips downloaded from Thunderstore/etc
 * and user uploads. Info-ZIP `unzip` and GNU `tar` already strip `../` and refuse to
 * write through a planted symlink (verified empirically on the current base image),
 * but that safety is the extractor's behaviour, not ours: a future switch to e.g.
 * busybox `unzip` (historically zip-slip-vulnerable) would regress it silently. So we
 * validate entry names OURSELVES before writing, and strip any symlinks afterward —
 * making the guarantee tool-independent and regression-tested.
 */

/** An entry name that could escape the destination: absolute, or with a `..` segment. */
function isUnsafeEntry(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (n.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(n)) return true; // absolute (unix / windows)
  return n.split(/[\\/]/).includes("..");
}

/** A mod/backup archive has no business shipping symlinks — they can point outside the
 *  extracted tree, and later code (or the game) following one would read off-tree.
 *  Remove every symlink under `dest` after extraction. */
async function stripSymlinks(dest: string): Promise<void> {
  await execFileP("find", [dest, "-type", "l", "-delete"]).catch(() => undefined);
}

/** Entry names inside a .zip, without extracting it — so a caller can vet an archive's
 *  CONTENTS (not just its paths) before anything touches disk. */
export async function listZipEntries(data: Buffer): Promise<string[]> {
  const tmp = join(tmpdir(), `listzip-${process.pid}-${Date.now()}.zip`);
  await writeFile(tmp, data);
  try {
    const { stdout } = await execFileP("unzip", ["-Z1", tmp]);
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    throw new BadRequestException(`Could not read the upload: ${(e as Error).message}`);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Extract an untrusted .zip (given as a Buffer) into `dest`. Rejects the whole archive
 *  up front if any entry is absolute or contains `..`, then strips any symlinks. */
export async function extractZipSafe(data: Buffer, dest: string): Promise<void> {
  const tmp = join(tmpdir(), `safezip-${process.pid}-${Date.now()}.zip`);
  await writeFile(tmp, data);
  try {
    // List entry names (`-Z1` = zipinfo, one filename per line) and vet them before
    // writing a single byte to disk.
    const { stdout } = await execFileP("unzip", ["-Z1", tmp]);
    const bad = stdout.split("\n").find(isUnsafeEntry);
    if (bad !== undefined) {
      throw new BadRequestException(`Archive rejected — unsafe path in entry "${bad.trim()}".`);
    }
    await execFileP("unzip", ["-o", "-qq", tmp, "-d", dest]);
    await stripSymlinks(dest);
  } catch (e) {
    if (e instanceof BadRequestException) throw e;
    throw new BadRequestException(`Could not unzip the upload: ${(e as Error).message}`);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Extract an untrusted .tar.gz at `archivePath` into `dest`. Vets entry names up front
 *  and drops archive-supplied ownership. (Symlinks are NOT stripped here — legitimate
 *  game saves may contain them, and GNU tar already refuses `..`/write-through-symlink.) */
export async function extractTarGzSafe(archivePath: string, dest: string): Promise<void> {
  try {
    const { stdout } = await execFileP("tar", ["tzf", archivePath]);
    const bad = stdout.split("\n").find(isUnsafeEntry);
    if (bad !== undefined) {
      throw new BadRequestException(`Archive rejected — unsafe path in entry "${bad.trim()}".`);
    }
    await execFileP("tar", ["xzf", archivePath, "-C", dest, "--no-same-owner"]);
  } catch (e) {
    if (e instanceof BadRequestException) throw e;
    // Corrupt/junk upload → the caller's 400, not an unhandled 500 (GH #10 polish).
    // execFile errors bury tar's own diagnostic in stderr — surface its first line.
    const stderr = (e as { stderr?: string }).stderr?.trim().split("\n")[0];
    throw new BadRequestException(`Not a valid .tar.gz archive: ${stderr || (e as Error).message}`);
  }
}

// Exposed for unit tests (validate the name-vetting without spawning a shell).
export const __test = { isUnsafeEntry };
