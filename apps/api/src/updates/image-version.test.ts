import { describe, it, expect } from "vitest";
import { resolveVersionTag, describeImageTag, type ImageTag } from "@ark/shared";

// GH #26: "latest" tells an admin nothing about which game build they're on. Images
// that bake the server in publish versioned aliases sharing one digest — these are
// the real tags/digests from danixu86/project-zomboid-dedicated-server.
const ZOMBOID: ImageTag[] = [
  { name: "latest", digest: "sha256:4501a705" },
  { name: "latest-release", digest: "sha256:4501a705" },
  { name: "42.20.3-release", digest: "sha256:4501a705" },
  { name: "42.20.2-release", digest: "sha256:26bc76b2" },
  { name: "42.20.0-release", digest: "sha256:89849c2d" },
  { name: "latest-unstable", digest: "sha256:21065d6a" },
];

describe("resolveVersionTag", () => {
  it("resolves latest to the versioned alias sharing its digest", () => {
    expect(resolveVersionTag(ZOMBOID, "latest")).toBe("42.20.3-release");
  });

  it("resolves an older pinned tag to itself's siblings only", () => {
    // 42.20.2 has no alias — nothing else shares that digest.
    expect(resolveVersionTag(ZOMBOID, "42.20.2-release")).toBeNull();
  });

  it("never answers with another floating tag", () => {
    // latest-release shares latest's digest but names a channel, not a build.
    expect(resolveVersionTag(ZOMBOID, "latest")).not.toBe("latest-release");
    expect(resolveVersionTag(ZOMBOID, "latest-unstable")).toBeNull();
  });

  it("prefers the most specific version when several alias one build", () => {
    // Some images publish a moving major alias next to the full version.
    const tags: ImageTag[] = [
      { name: "latest", digest: "d1" },
      { name: "42", digest: "d1" },
      { name: "42.20.3-release", digest: "d1" },
    ];
    expect(resolveVersionTag(tags, "latest")).toBe("42.20.3-release");
  });

  it("returns null when the registry lists no digests (GHCR)", () => {
    // GHCR's tags/list has names only — the feature degrades, it doesn't guess.
    const tags: ImageTag[] = [
      { name: "latest", digest: null },
      { name: "v1.8.1", digest: null },
    ];
    expect(resolveVersionTag(tags, "latest")).toBeNull();
  });

  it("returns null for a tag the registry doesn't list", () => {
    expect(resolveVersionTag(ZOMBOID, "no-such-tag")).toBeNull();
  });

  it("ignores non-version aliases like 'stable'", () => {
    const tags: ImageTag[] = [
      { name: "latest", digest: "d1" },
      { name: "stable", digest: "d1" },
    ];
    expect(resolveVersionTag(tags, "latest")).toBeNull();
  });
});

describe("describeImageTag", () => {
  it("annotates a floating tag with the build it points at", () => {
    expect(describeImageTag(ZOMBOID, "latest")).toBe("latest (42.20.3-release)");
  });

  it("leaves an already-specific tag alone", () => {
    expect(describeImageTag(ZOMBOID, "42.20.2-release")).toBe("42.20.2-release");
  });
});
