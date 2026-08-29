/**
 * Which backups retention is allowed to delete.
 *
 * Every snapshot records WHY it was taken (`Snapshot.reason`): `manual` when a user
 * pressed Backup, and `scheduled` / `pre-<action>` / `auto-stop` when Palisade took
 * one on its own. Retention used to ignore that and simply keep the newest N of
 * everything, so a manual backup taken before a risky change was silently rotated
 * out by the scheduled ones that followed it (GH #34).
 *
 * Manual backups are now never pruned — they are kept until deleted by hand, and
 * they do not count against the keep-N budget either, so "keep 10" means ten
 * automatic restore points regardless of how many manual ones sit beside them.
 */

/** The reason recorded for a user-initiated backup. */
export const MANUAL_REASON = "manual";

/** True for a backup a person asked for, as opposed to one Palisade took itself. */
export function isManualReason(reason: string): boolean {
  return reason === MANUAL_REASON;
}

/**
 * Snapshot directories are named `<reason>-<ISO stamp>`, and the replication target
 * stores them as `<reason>-<ISO stamp>.tar.gz` — so the remote side can tell manual
 * artifacts apart without consulting the database.
 */
export function isManualArtifact(fileName: string): boolean {
  return fileName.startsWith(`${MANUAL_REASON}-`);
}

/**
 * The timestamp portion of such a name, for ordering. Returns "" when the name
 * doesn't parse, which sorts first — an unrecognised artifact is treated as oldest
 * and so is pruned before anything we understand.
 *
 * Sorting matters remotely: artifact names begin with the reason, so a plain
 * alphabetical sort groups by reason and would delete every `auto-stop-*` before any
 * `scheduled-*`, no matter which was older.
 */
export function artifactTimestamp(fileName: string): string {
  const base = fileName.replace(/\.tar\.gz$/, "");
  const dash = base.indexOf("-");
  return dash === -1 ? "" : base.slice(dash + 1);
}

/**
 * The snapshots to delete so that only the newest `keep` AUTOMATIC ones survive.
 * Manual snapshots are never returned. Input order doesn't matter.
 */
export function snapshotsToPrune<T extends { reason: string; createdAt: Date }>(
  snapshots: readonly T[],
  keep: number,
): T[] {
  const automatic = snapshots
    .filter((s) => !isManualReason(s.reason))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return automatic.slice(Math.max(0, keep));
}

/**
 * The remote artifact filenames to delete, same rule as above: manual artifacts are
 * kept and excluded from the count, the rest are ordered oldest-first by their
 * timestamp and trimmed to `keep`.
 */
export function artifactsToPrune(fileNames: readonly string[], keep: number): string[] {
  const automatic = fileNames
    .filter((f) => !isManualArtifact(f))
    .sort((a, b) => artifactTimestamp(a).localeCompare(artifactTimestamp(b)));
  return automatic.slice(0, Math.max(0, automatic.length - Math.max(0, keep)));
}
