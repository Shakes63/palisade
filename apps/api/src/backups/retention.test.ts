import { describe, it, expect } from "vitest";
import {
  artifactTimestamp,
  artifactsToPrune,
  isManualArtifact,
  isManualReason,
  snapshotsToPrune,
} from "./retention";

// GH #34: retention kept the newest N of EVERYTHING, so a backup someone took by
// hand before a risky change was silently rotated out by the scheduled ones after
// it. This is deletion logic — the exemption has to hold in both directions.

const at = (iso: string) => new Date(iso);
const snap = (id: string, reason: string, iso: string) => ({ id, reason, createdAt: at(iso) });

describe("snapshotsToPrune", () => {
  it("never prunes a manual backup, however old", () => {
    const snaps = [
      snap("m", "manual", "2026-01-01T00:00:00Z"),
      snap("a", "scheduled", "2026-06-01T00:00:00Z"),
      snap("b", "scheduled", "2026-06-02T00:00:00Z"),
    ];
    expect(snapshotsToPrune(snaps, 1).map((s) => s.id)).toEqual(["a"]);
  });

  it("does not count manual backups against the keep budget", () => {
    // "keep 2" means two automatic restore points, no matter how many manual ones
    // sit beside them — otherwise manual backups would starve the rotation.
    const snaps = [
      snap("m1", "manual", "2026-01-01T00:00:00Z"),
      snap("m2", "manual", "2026-01-02T00:00:00Z"),
      snap("a", "scheduled", "2026-06-01T00:00:00Z"),
      snap("b", "scheduled", "2026-06-02T00:00:00Z"),
    ];
    expect(snapshotsToPrune(snaps, 2)).toEqual([]);
  });

  it("keeps the newest N automatic and prunes the rest", () => {
    const snaps = [
      snap("old", "scheduled", "2026-06-01T00:00:00Z"),
      snap("mid", "pre-update", "2026-06-02T00:00:00Z"),
      snap("new", "auto-stop", "2026-06-03T00:00:00Z"),
    ];
    expect(snapshotsToPrune(snaps, 1).map((s) => s.id).sort()).toEqual(["mid", "old"]);
  });

  it("treats every non-manual reason as automatic", () => {
    for (const reason of ["scheduled", "pre-update", "pre-restart", "pre-restore", "pre-import", "auto-stop"]) {
      expect(isManualReason(reason), reason).toBe(false);
      expect(snapshotsToPrune([snap("x", reason, "2026-01-01T00:00:00Z")], 0)).toHaveLength(1);
    }
    expect(isManualReason("manual")).toBe(true);
  });

  it("is insensitive to input order", () => {
    const snaps = [
      snap("b", "scheduled", "2026-06-02T00:00:00Z"),
      snap("old", "scheduled", "2026-06-01T00:00:00Z"),
      snap("c", "scheduled", "2026-06-03T00:00:00Z"),
    ];
    expect(snapshotsToPrune([...snaps].reverse(), 2)).toEqual(snapshotsToPrune(snaps, 2));
    expect(snapshotsToPrune(snaps, 2).map((s) => s.id)).toEqual(["old"]);
  });

  it("prunes every automatic backup when keep is 0", () => {
    const snaps = [snap("m", "manual", "2026-01-01T00:00:00Z"), snap("a", "scheduled", "2026-06-01T00:00:00Z")];
    expect(snapshotsToPrune(snaps, 0).map((s) => s.id)).toEqual(["a"]);
  });

  it("prunes nothing when there are fewer automatic backups than keep", () => {
    expect(snapshotsToPrune([snap("a", "scheduled", "2026-06-01T00:00:00Z")], 10)).toEqual([]);
  });
});

describe("artifactsToPrune (replication target)", () => {
  it("keeps manual artifacts and leaves them out of the count", () => {
    const files = [
      "manual-2026-01-01T00-00-00-000Z.tar.gz",
      "scheduled-2026-06-01T00-00-00-000Z.tar.gz",
      "scheduled-2026-06-02T00-00-00-000Z.tar.gz",
    ];
    expect(artifactsToPrune(files, 2)).toEqual([]);
    expect(artifactsToPrune(files, 1)).toEqual(["scheduled-2026-06-01T00-00-00-000Z.tar.gz"]);
  });

  it("orders by timestamp, not by filename", () => {
    // Names start with the reason, so a plain sort would delete the alphabetically
    // first prefix wholesale — here every auto-stop before the older scheduled one.
    const files = [
      "auto-stop-2026-06-05T00-00-00-000Z.tar.gz",
      "scheduled-2026-06-01T00-00-00-000Z.tar.gz",
    ];
    expect(artifactsToPrune(files, 1)).toEqual(["scheduled-2026-06-01T00-00-00-000Z.tar.gz"]);
  });

  it("recognises manual artifacts by prefix only", () => {
    expect(isManualArtifact("manual-2026-06-01T00-00-00-000Z.tar.gz")).toBe(true);
    // A server whose reason merely contains the word must not be mistaken for one.
    expect(isManualArtifact("pre-manual-2026-06-01T00-00-00-000Z.tar.gz")).toBe(false);
    expect(isManualArtifact("scheduled-2026-06-01T00-00-00-000Z.tar.gz")).toBe(false);
  });

  it("extracts the timestamp from both directory and artifact names", () => {
    expect(artifactTimestamp("scheduled-2026-06-01T00-00-00-000Z.tar.gz")).toBe("2026-06-01T00-00-00-000Z");
    expect(artifactTimestamp("pre-update-2026-06-01T00-00-00-000Z")).toBe("update-2026-06-01T00-00-00-000Z");
  });

  it("sorts an unparseable name first, so it is pruned before anything understood", () => {
    const files = ["garbage.tar.gz", "scheduled-2026-06-01T00-00-00-000Z.tar.gz"];
    expect(artifactsToPrune(files, 1)).toEqual(["garbage.tar.gz"]);
  });

  it("prunes nothing when under the limit", () => {
    expect(artifactsToPrune(["scheduled-2026-06-01T00-00-00-000Z.tar.gz"], 10)).toEqual([]);
  });
});
