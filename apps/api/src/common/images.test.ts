import { describe, it, expect } from "vitest";
import { Game } from "@ark/shared";
import {
  splitImageRef,
  imageRefFor,
  imageRepoFor,
  defaultImageTagFor,
  gameForImageRef,
  IMAGES,
  IMAGE_TAG_RE,
} from "./images";

describe("splitImageRef", () => {
  it("splits repo:tag on the last colon after the last slash", () => {
    expect(splitImageRef("ich777/openttdserver:latest")).toEqual({
      repo: "ich777/openttdserver",
      tag: "latest",
    });
    expect(splitImageRef("acekorneya/asa_server:2_1_latest")).toEqual({
      repo: "acekorneya/asa_server",
      tag: "2_1_latest",
    });
    expect(splitImageRef("ghcr.io/ripps818/docker-x:latest")).toEqual({
      repo: "ghcr.io/ripps818/docker-x",
      tag: "latest",
    });
  });
  it("defaults to :latest when no tag is present", () => {
    expect(splitImageRef("itzg/minecraft-server")).toEqual({ repo: "itzg/minecraft-server", tag: "latest" });
  });
  it("does not mistake a registry port for a tag", () => {
    expect(splitImageRef("registry:5000/team/app")).toEqual({ repo: "registry:5000/team/app", tag: "latest" });
  });
});

describe("imageRefFor", () => {
  it("keeps the shipped default when no pin is given", () => {
    const repo = imageRepoFor(Game.MINECRAFT);
    expect(imageRefFor(Game.MINECRAFT)).toBe(`${repo}:${defaultImageTagFor(Game.MINECRAFT)}`);
    expect(imageRefFor(Game.MINECRAFT, null)).toBe(`${repo}:${defaultImageTagFor(Game.MINECRAFT)}`);
    expect(imageRefFor(Game.MINECRAFT, "  ")).toBe(`${repo}:${defaultImageTagFor(Game.MINECRAFT)}`);
  });
  it("substitutes only the tag, keeping the repo", () => {
    expect(imageRefFor(Game.MINECRAFT, "1.20.4")).toBe(`${imageRepoFor(Game.MINECRAFT)}:1.20.4`);
  });
  it("ignores an invalid tag and falls back to the default", () => {
    const def = `${imageRepoFor(Game.MINECRAFT)}:${defaultImageTagFor(Game.MINECRAFT)}`;
    expect(imageRefFor(Game.MINECRAFT, "bad tag!")).toBe(def);
    expect(imageRefFor(Game.MINECRAFT, "../evil")).toBe(def);
  });
});

describe("IMAGE_TAG_RE", () => {
  it("accepts valid docker tags and rejects malformed ones", () => {
    for (const ok of ["latest", "1.20.4", "v3.0.1", "2_1_latest", "sha-abc123"]) {
      expect(IMAGE_TAG_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["", "bad tag", "-leadingdash", "a/b", "../x", "tag;rm", ".start"]) {
      expect(IMAGE_TAG_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("gameForImageRef", () => {
  it("resolves every image we ship back to its own game", () => {
    for (const [game, ref] of Object.entries(IMAGES)) {
      expect(gameForImageRef(ref), ref).toBe(game);
    }
  });

  it("tells apart the games sharing ich777's SteamCMD wrapper (GH #77)", () => {
    expect(gameForImageRef("ghcr.io/ich777/steamcmd:ets2")).toBe(Game.ETS2);
    expect(gameForImageRef("ghcr.io/ich777/steamcmd:ats")).toBe(Game.ATS);
    expect(gameForImageRef("ghcr.io/ich777/steamcmd:lifyo")).toBe(Game.LIF);
  });

  it("does not guess a game for wrapper tags we don't manage", () => {
    // These used to resolve to whichever shared-repo game was declared last —
    // an adopted Palworld/V Rising container came back as Euro Truck Simulator 2.
    expect(gameForImageRef("ghcr.io/ich777/steamcmd:palworld")).toBeUndefined();
    expect(gameForImageRef("ghcr.io/ich777/steamcmd:vrising")).toBeUndefined();
    expect(gameForImageRef("ghcr.io/ich777/steamcmd")).toBeUndefined();
  });

  it("matches any tag on a repo only one game uses", () => {
    expect(gameForImageRef("hermsi/ark-server:1.2")).toBe(Game.ASE);
    expect(gameForImageRef("itzg/minecraft-server")).toBe(Game.MINECRAFT);
    expect(gameForImageRef("docker.io/itzg/minecraft-server:java21")).toBe(Game.MINECRAFT);
  });

  it("returns undefined for images we don't manage", () => {
    expect(gameForImageRef("lscr.io/linuxserver/plex")).toBeUndefined();
    expect(gameForImageRef("")).toBeUndefined();
  });
});
