import { afterEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game } from "@ark/shared";
import { LocalPaths } from "../common/paths";
import {
  alignVRisingWorldName,
  FOREIGN_IMAGES,
  foreignImageFor,
  resolveBind,
} from "./foreign-images";

describe("foreignImageFor", () => {
  it("matches the ich777 wrapper tag by tag, not repo", () => {
    expect(foreignImageFor("ghcr.io/ich777/steamcmd:palworld")?.game).toBe(Game.PALWORLD);
    expect(foreignImageFor("ghcr.io/ich777/steamcmd:vrising")?.game).toBe(Game.VRISING);
    // Tags we run ourselves must not be diverted through the mapping.
    expect(foreignImageFor("ghcr.io/ich777/steamcmd:ets2")).toBeUndefined();
    expect(foreignImageFor("itzg/minecraft-server:latest")).toBeUndefined();
  });

  it("maps onto the same subpaths a backup captures", () => {
    // Adoption should leave an instance holding what a restore would put back,
    // so every destination has to be a save subpath for that game.
    for (const foreign of Object.values(FOREIGN_IMAGES)) {
      const subpaths = LocalPaths.saveSubpaths(foreign.game);
      for (const ourPath of Object.keys(foreign.paths)) {
        expect(
          subpaths.some((s) => ourPath.endsWith(s)) || subpaths.includes(""),
          `${ourPath} is not one of ${foreign.game}'s save subpaths (${subpaths.join(", ")})`,
        ).toBe(true);
      }
    }
  });
});

describe("resolveBind", () => {
  const ich777 = { "/serverdata": "/mnt/user/appdata/palworld" };

  it("splits a container path into its bind and the rest", () => {
    expect(resolveBind(ich777, "/serverdata/serverfiles/Pal/Saved")).toEqual({
      hostRoot: "/mnt/user/appdata/palworld",
      subpath: "serverfiles/Pal/Saved",
    });
  });

  it("returns an empty subpath when the bind IS the path", () => {
    expect(resolveBind({ "/mnt/vrising/persistentdata": "/data/x" }, "/mnt/vrising/persistentdata"))
      .toEqual({ hostRoot: "/data/x", subpath: "" });
  });

  it("prefers the deepest bind when one nests inside another", () => {
    const binds = { "/serverdata": "/mnt/a", "/serverdata/serverfiles/save-data": "/mnt/b" };
    expect(resolveBind(binds, "/serverdata/serverfiles/save-data")).toEqual({
      hostRoot: "/mnt/b",
      subpath: "",
    });
  });

  it("is null when nothing persists that path", () => {
    expect(resolveBind(ich777, "/opt/elsewhere")).toBeNull();
    // A sibling whose name merely starts the same is not a parent.
    expect(resolveBind({ "/serverdata": "/mnt/a" }, "/serverdata-backup/x")).toBeNull();
  });
});

describe("alignVRisingWorldName", () => {
  const roots: string[] = [];
  const instance = async (worlds: string[], version = "v4"): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "palisade-vr-"));
    roots.push(root);
    for (const w of worlds) {
      await mkdir(join(root, "persistentdata", "Saves", version, w), { recursive: true });
      await writeFile(join(root, "persistentdata", "Saves", version, w, "AutoSave.save"), w);
    }
    return root;
  };
  const worldsIn = (root: string, version = "v4") =>
    readdir(join(root, "persistentdata", "Saves", version));

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  it("renames a lone world so WORLDNAME=world1 finds it", async () => {
    const root = await instance(["Dracula"]);
    expect(await alignVRisingWorldName(root)).toEqual(["Dracula"]);
    expect(await worldsIn(root)).toEqual(["world1"]);
  });

  it("leaves a save that is already world1 alone", async () => {
    const root = await instance(["world1"]);
    expect(await alignVRisingWorldName(root)).toEqual([]);
    expect(await worldsIn(root)).toEqual(["world1"]);
  });

  it("won't choose between several worlds", async () => {
    const root = await instance(["Dracula", "Solarus"]);
    expect(await alignVRisingWorldName(root)).toEqual([]);
    expect((await worldsIn(root)).sort()).toEqual(["Dracula", "Solarus"]);
  });

  it("follows whichever save version the game is on", async () => {
    const root = await instance(["Dracula"], "v3");
    expect(await alignVRisingWorldName(root)).toEqual(["Dracula"]);
    expect(await worldsIn(root, "v3")).toEqual(["world1"]);
  });

  it("does nothing when no save came across", async () => {
    const root = await mkdtemp(join(tmpdir(), "palisade-vr-"));
    roots.push(root);
    expect(await alignVRisingWorldName(root)).toEqual([]);
  });
});
