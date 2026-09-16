import { BadRequestException } from "@nestjs/common";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

/**
 * Resolve an untrusted relative path to an absolute path guaranteed to live inside
 * `root`. Rejects absolute paths, null bytes, and anything that escapes lexically;
 * then (for the deepest existing ancestor) verifies the REAL path is still inside
 * the root, so a symlink inside the tree can't point the operation outside it.
 *
 * `root` must already be canonical — pass it through {@link canonicalRoot} (or an
 * equivalent realpath) first, or the symlink check compares against a path the
 * filesystem would resolve differently and lets an escape through.
 *
 * Note this ALLOWS `rel` resolving to the root itself (that's how a listing of "."
 * works). Callers that must not operate on the root reject it themselves.
 *
 * Shared by the file manager and the per-game mod services: every one of them takes
 * a path from the client, so they get one hardened containment check rather than a
 * private reimplementation each.
 */
export async function resolveSafe(root: string, rel: string): Promise<string> {
  if (rel.includes("\0")) throw new BadRequestException("Invalid path");
  if (isAbsolute(rel)) throw new BadRequestException("Path must be relative");
  const target = resolve(root, normalize(rel));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new BadRequestException("Path escapes the server directory");
  }
  // Walk up to the deepest EXISTING ancestor and canonicalize it — a symlinked
  // parent directory could otherwise smuggle the target outside the root.
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== root && !real.startsWith(root + sep)) {
        throw new BadRequestException("Path escapes the server directory (symlink)");
      }
      break;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      const parent = dirname(probe);
      if (parent === probe) break; // hit the filesystem root without existing — fine
      probe = parent;
    }
  }
  return target;
}

/** Canonicalize a directory for use as {@link resolveSafe}'s root, or null when it
 *  doesn't exist yet — a mod dir is only created on first upload, and "nothing is
 *  in there" is a normal answer rather than an error. */
export async function canonicalRoot(dir: string): Promise<string | null> {
  return realpath(dir).catch(() => null);
}
