import { describe, it, expect } from "vitest";
import { Game } from "@ark/shared";
import { parseAuthChallenge, tokenUrlFor, splitRepo, digestsDiffer } from "./registry-digest";
import { IMAGE_BAKED_GAMES } from "../common/images";

// GH #26: games whose server ships inside the image have no SteamCMD appmanifest, so
// the build-id check silently never fired for them. These back the digest comparison
// that replaces it.

describe("parseAuthChallenge", () => {
  it("reads Docker Hub's bearer challenge", () => {
    expect(
      parseAuthChallenge(
        'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:danixu86/project-zomboid-dedicated-server:pull"',
      ),
    ).toEqual({
      realm: "https://auth.docker.io/token",
      service: "registry.docker.io",
      scope: "repository:danixu86/project-zomboid-dedicated-server:pull",
    });
  });

  it("reads ghcr's challenge, which omits nothing but uses a different realm", () => {
    expect(
      parseAuthChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:shakes63/palisade:pull"'),
    ).toMatchObject({ realm: "https://ghcr.io/token", service: "ghcr.io" });
  });

  it("returns null for anything we can't follow", () => {
    // Basic auth, a missing header, or a Bearer with no realm are all "give up
    // quietly" — the caller then reports unknown rather than a false update.
    expect(parseAuthChallenge('Basic realm="x"')).toBeNull();
    expect(parseAuthChallenge(null)).toBeNull();
    expect(parseAuthChallenge("Bearer service=\"registry.docker.io\"")).toBeNull();
  });
});

describe("tokenUrlFor", () => {
  it("carries service and scope onto the realm", () => {
    expect(
      tokenUrlFor({ realm: "https://auth.docker.io/token", service: "registry.docker.io", scope: "repository:a/b:pull" }),
    ).toBe("https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Aa%2Fb%3Apull");
  });

  it("omits absent params rather than sending empties", () => {
    expect(tokenUrlFor({ realm: "https://ghcr.io/token" })).toBe("https://ghcr.io/token");
  });
});

describe("splitRepo", () => {
  it("applies Docker Hub's implicit library/ for a bare name", () => {
    expect(splitRepo("postgres")).toEqual({ registry: "registry-1.docker.io", path: "library/postgres" });
  });

  it("keeps user/name on Docker Hub", () => {
    expect(splitRepo("danixu86/project-zomboid-dedicated-server")).toEqual({
      registry: "registry-1.docker.io",
      path: "danixu86/project-zomboid-dedicated-server",
    });
  });

  it("treats a dotted first segment as a registry host", () => {
    expect(splitRepo("ghcr.io/shakes63/palisade")).toEqual({
      registry: "ghcr.io",
      path: "shakes63/palisade",
    });
  });

  it("treats a host:port first segment as a registry host", () => {
    expect(splitRepo("localhost:5000/thing")).toEqual({ registry: "localhost:5000", path: "thing" });
  });
});

describe("digestsDiffer", () => {
  it("flags an update when the tag moved to a new digest", () => {
    expect(digestsDiffer("sha256:aaa", "sha256:bbb")).toBe(true);
  });

  it("is quiet when they match", () => {
    expect(digestsDiffer("sha256:aaa", "sha256:aaa")).toBe(false);
  });

  it("never cries wolf when either side is unknown", () => {
    // A locally-built image (no RepoDigests) or an unreachable registry must not
    // read as "update available".
    expect(digestsDiffer(null, "sha256:bbb")).toBe(false);
    expect(digestsDiffer("sha256:aaa", null)).toBe(false);
    expect(digestsDiffer(null, null)).toBe(false);
  });
});

describe("IMAGE_BAKED_GAMES", () => {
  it("covers the games whose docs say the server ships in the image", () => {
    for (const g of [Game.ZOMBOID, Game.BEAMMP, Game.FACTORIO, Game.TERRARIA]) {
      expect(IMAGE_BAKED_GAMES.has(g), g).toBe(true);
    }
  });

  it("excludes games that download their server at a user-chosen version", () => {
    // A new itzg image doesn't mean a new Minecraft version — flagging it is noise.
    for (const g of [Game.MINECRAFT, Game.BEDROCK, Game.OPENTTD]) {
      expect(IMAGE_BAKED_GAMES.has(g), g).toBe(false);
    }
  });

  it("excludes SteamCMD games, which the appmanifest path handles", () => {
    for (const g of [Game.ASA, Game.ASE, Game.VALHEIM, Game.RUST]) {
      expect(IMAGE_BAKED_GAMES.has(g), g).toBe(false);
    }
  });
});
