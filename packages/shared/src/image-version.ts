import type { ImageTag } from "./dto";

/**
 * Working out which concrete game version a floating tag currently points at.
 *
 * Images that bake the game in (Project Zomboid, and others) publish a moving tag
 * plus versioned aliases for the SAME build — e.g. `latest`, `latest-release` and
 * `42.20.3-release` all share one digest. Showing only "latest" leaves an admin with
 * no way to know WHICH game version they're on or about to pull, which is exactly
 * the gap reported in GH #26 (the user resorted to watching the boot log scroll by).
 *
 * Registries already hand us the per-tag digest in the listing we fetch for the
 * version picker, so this is pure grouping — no extra requests.
 */

/** Tags that move (they name a channel, not a build) and so can never be the answer. */
const FLOATING = /^(latest|stable|release|nightly|unstable|beta|dev|main|master|edge)(-.*)?$/i;

/** Looks like a version: contains a digit, and isn't purely a date-less word. */
const VERSION_LIKE = /\d/;

/**
 * The most specific version-looking tag sharing `tag`'s digest, or null when the
 * registry gave us no digests (GHCR's tag list omits them) or nothing else points
 * at the same build.
 *
 * Prefers the longest candidate so `42.20.3-release` wins over a bare `42`, which
 * some images also publish as a moving major-version alias.
 */
export function resolveVersionTag(tags: readonly ImageTag[], tag: string): string | null {
  const digest = tags.find((t) => t.name === tag)?.digest;
  if (!digest) return null;
  const siblings = tags
    .filter((t) => t.name !== tag && t.digest === digest)
    .map((t) => t.name)
    .filter((name) => VERSION_LIKE.test(name) && !FLOATING.test(name));
  if (!siblings.length) return null;
  return siblings.sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? null;
}

/** "latest (42.20.3-release)" for display, or just the tag when unresolvable. */
export function describeImageTag(tags: readonly ImageTag[], tag: string): string {
  const version = resolveVersionTag(tags, tag);
  return version ? `${tag} (${version})` : tag;
}
