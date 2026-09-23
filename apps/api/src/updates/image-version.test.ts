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

  // Real aliases seen on Docker Hub: hermsi/ark-server, lloesche/valheim-server,
  // itzg/minecraft-server and acekorneya/asa_server.
  it.each(["tools-b709d0bda5a6662a15242102bd4f711f3d0fe93e", "sha-e36cbfb0ddc8", "java25", "2_1_beta", "latest-1789974994"])(
    "never answers with the commit, variant or channel tag %s",
    (alias) => {
      const tags: ImageTag[] = [
        { name: "latest", digest: "d1" },
        { name: alias, digest: "d1" },
      ];
      expect(resolveVersionTag(tags, "latest")).toBeNull();
    },
  );

  it("leaves a tag that is already a version alone rather than shortening it", () => {
    // ferment9348/dragonwilds: the shipped tag 1.1.1 shares a digest with 1.1.
    const tags: ImageTag[] = [
      { name: "1.1.1", digest: "d1" },
      { name: "1.1", digest: "d1" },
      { name: "latest", digest: "d1" },
    ];
    expect(resolveVersionTag(tags, "1.1.1")).toBeNull();
  });

  it("still resolves to a bare major, a v-prefixed version or a build date", () => {
    const tag = (name: string): ImageTag[] => [
      { name: "latest", digest: "d1" },
      { name, digest: "d1" },
    ];
    expect(resolveVersionTag(tag("v2.8.1"), "latest")).toBe("v2.8.1");
    expect(resolveVersionTag(tag("2"), "latest")).toBe("2");
    expect(resolveVersionTag(tag("2026-04-23-1036"), "latest")).toBe("2026-04-23-1036");
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
