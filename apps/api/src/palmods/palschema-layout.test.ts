import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game } from "@ark/shared";
import { PalModsService, planPalSchemaMods, PAL_SCHEMA_DLL, PAL_FRAMEWORK_WINE_LOADER } from "./palmods.service";

/**
 * Mod authors package PalSchema mods at four different depths (all four shapes are
 * real, taken from actual Nexus uploads). Extracting verbatim only ever worked for the
 * shallow two, so these pin the placement for each.
 */
describe("planPalSchemaMods", () => {
  it("takes what's under the PalSchema/mods marker, however deep it sits", () => {
    expect(planPalSchemaMods(["Mods/PalSchema/mods/Fancy Mod/items/x.jsonc"], "up")).toEqual([
      { name: "Fancy Mod", from: "Mods/PalSchema/mods/Fancy Mod" },
    ]);
    // The full-game-path shape, packaged for UE4SS's newer ue4ss/Mods layout.
    expect(
      planPalSchemaMods(["Pal/Binaries/Win64/ue4ss/Mods/PalSchema/mods/Deep/raw/r.json"], "up"),
    ).toEqual([{ name: "Deep", from: "Pal/Binaries/Win64/ue4ss/Mods/PalSchema/mods/Deep" }]);
  });

  it("treats a bare top-level folder holding JSON as the mod", () => {
    expect(planPalSchemaMods(["ModName/blueprints/a.jsonc", "ModName/README.txt"], "up")).toEqual([
      { name: "ModName", from: "ModName" },
    ]);
  });

  it("names a flat archive of JSON after the upload", () => {
    expect(planPalSchemaMods(["a.json", "b.jsonc"], "My Mod")).toEqual([{ name: "My Mod", from: "" }]);
  });

  it("ignores archive junk and folder-only entries", () => {
    expect(
      planPalSchemaMods(["__MACOSX/._x", "ModName/", "ModName/.DS_Store", "ModName/raw/a.json"], "up"),
    ).toEqual([{ name: "ModName", from: "ModName" }]);
  });

  it("returns nothing for an archive with no JSON at all (e.g. a pak mod)", () => {
    expect(planPalSchemaMods(["ModName/ModName_P.pak", "ModName/ModName_P.ucas"], "up")).toEqual([]);
  });

  it("does not mistake the mods dir itself for a mod", () => {
    expect(planPalSchemaMods(["Mods/PalSchema/mods/README.txt"], "up")).toEqual([]);
  });
});

/** Installs a real zip end to end and asserts where the files landed. */
describe("addPalSchemaMod() placement", () => {
  let dataDir: string;
  let instance: string;
  let modsDir: string;
  let svc: PalModsService;

  beforeEach(async () => {
    process.env.SECRETS_KEY = "a".repeat(64);
    process.env.JWT_SECRET = "test-jwt-secret-1234";
    dataDir = await mkdtemp(join(tmpdir(), "palschema-"));
    process.env.DATA_DIR = dataDir;
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();

    instance = join(dataDir, "instances", "srv1");
    modsDir = join(instance, "Pal/Binaries/Win64/Mods/PalSchema/mods");
    // The gates addPalSchemaMod checks: UE4SS loader + PalSchema's own DLL.
    await mkdir(join(instance, "Pal/Binaries/Win64/Mods/PalSchema/dlls"), { recursive: true });
    await writeFile(join(instance, PAL_FRAMEWORK_WINE_LOADER), "");
    await writeFile(join(instance, PAL_SCHEMA_DLL), "");

    svc = new PalModsService({
      server: { findUnique: async () => ({ id: "srv1", game: Game.PALWORLD_WINE, configJson: "{}" }) },
    } as never);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    const { resetEnvCache } = await import("../config/env");
    resetEnvCache();
  });

  /**
   * Build a real .zip in memory from a {path: content} map. Stored (method 0), which
   * `unzip` reads happily — the archives here are about LAYOUT, not compression.
   *
   * In-process on purpose: the `zip` CLI isn't in the API image (only `unzip` is), and
   * embedding base64 blobs the way safe-extract.test.ts does would make a test whose
   * whole subject is directory shape unreadable.
   */
  const makeZip = (files: Record<string, string>): Buffer => {
    const table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc32 = (b: Buffer) => {
      let c = 0xffffffff;
      for (const byte of b) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };

    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [rel, body] of Object.entries(files)) {
      const name = Buffer.from(rel, "utf8");
      const data = Buffer.from(body, "utf8");
      const crc = crc32(data);

      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4); // version needed
      lfh.writeUInt16LE(0, 8); // method: stored
      lfh.writeUInt32LE(crc, 14);
      lfh.writeUInt32LE(data.length, 18);
      lfh.writeUInt32LE(data.length, 22);
      lfh.writeUInt16LE(name.length, 26);
      locals.push(lfh, name, data);

      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);
      cdh.writeUInt16LE(20, 4); // version made by
      cdh.writeUInt16LE(20, 6); // version needed
      cdh.writeUInt16LE(0, 10); // method: stored
      cdh.writeUInt32LE(crc, 16);
      cdh.writeUInt32LE(data.length, 20);
      cdh.writeUInt32LE(data.length, 24);
      cdh.writeUInt16LE(name.length, 28);
      cdh.writeUInt32LE(offset, 42);
      central.push(cdh, name);

      offset += lfh.length + name.length + data.length;
    }

    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(files).length, 8);
    eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  };

  const tree = async (dir: string) =>
    (await readdir(dir, { recursive: true }).catch(() => [] as string[])).sort();

  it("places a deeply-prefixed archive at the mods root, not nested under its own path", async () => {
    const zip = makeZip({
      "Pal/Binaries/Win64/ue4ss/Mods/PalSchema/mods/SkillBookEZ/raw/recipe.json": "{}",
      "Pal/Binaries/Win64/ue4ss/Mods/PalSchema/mods/SkillBookEZ/blueprints/s.json": "{}",
    });
    await svc.addPalSchemaMod("srv1", "mod.zip", zip);
    expect(await tree(modsDir)).toEqual([
      "SkillBookEZ",
      "SkillBookEZ/blueprints",
      "SkillBookEZ/blueprints/s.json",
      "SkillBookEZ/raw",
      "SkillBookEZ/raw/recipe.json",
    ]);
  });

  it("places a bare mod folder unchanged", async () => {
    const zip = makeZip({ "BaseCampItemStacker/blueprints/b.jsonc": "{}" });
    await svc.addPalSchemaMod("srv1", "mod.zip", zip);
    expect(await tree(modsDir)).toContain("BaseCampItemStacker/blueprints/b.jsonc");
  });

  it("replaces an existing mod wholesale rather than merging stale files into it", async () => {
    await svc.addPalSchemaMod("srv1", "m.zip", makeZip({ "Mod/raw/old.json": "{}" }));
    await svc.addPalSchemaMod("srv1", "m.zip", makeZip({ "Mod/raw/new.json": "{}" }));
    const t = await tree(modsDir);
    expect(t).toContain("Mod/raw/new.json");
    expect(t).not.toContain("Mod/raw/old.json");
  });

  it("leaves no staging directory behind, on success or on rejection", async () => {
    await svc.addPalSchemaMod("srv1", "m.zip", makeZip({ "Mod/raw/a.json": "{}" }));
    await expect(
      svc.addPalSchemaMod("srv1", "m.zip", makeZip({ "Mod/Mod_P.pak": "x" })),
    ).rejects.toThrow(/No PalSchema mod found/i);
    const leftovers = (await readdir(instance)).filter((e) => e.startsWith(".palschema-upload-"));
    expect(leftovers).toEqual([]);
  });

  it("lists the mod's JSON recursively, as instance-relative paths the files API takes", async () => {
    await svc.addPalSchemaMod(
      "srv1",
      "m.zip",
      makeZip({
        "Acc/items/a.jsonc": "{}",
        "Acc/translations/en/t.jsonc": "{}",
        "Acc/README.txt": "docs",
      }),
    );
    const { files } = await svc.palSchemaModConfigFiles("srv1", "Acc");
    expect(files).toEqual([
      "Pal/Binaries/Win64/Mods/PalSchema/mods/Acc/items/a.jsonc",
      "Pal/Binaries/Win64/Mods/PalSchema/mods/Acc/translations/en/t.jsonc",
    ]);
  });

  it("delete removes the mod's files from disk, not just from the listing", async () => {
    // A real-world name: spaces and punctuation, like "ZZZ_MelwenMods - Improved
    // Accessories". The old basename() strip passed these through untouched; the
    // resolveSafe() guard has to as well.
    const mod = "ZZZ_MelwenMods - Improved Accessories";
    await svc.addPalSchemaMod(
      "srv1",
      "m.zip",
      makeZip({
        [`${mod}/items/a.jsonc`]: "{}",
        [`${mod}/translations/en/t.jsonc`]: "{}",
        [`${mod}/README.txt`]: "d",
      }),
    );
    expect(await tree(modsDir)).toContain(`${mod}/translations/en/t.jsonc`);

    const st = await svc.removePalSchemaMod("srv1", mod);
    // Gone from disk, nested files and all — not merely absent from the response.
    expect(await tree(modsDir)).toEqual([]);
    expect(st.palschema?.mods).toEqual([]);
  });

  it("delete leaves the other mods and PalSchema's own DLL alone", async () => {
    await svc.addPalSchemaMod("srv1", "a.zip", makeZip({ "KeepMe/raw/a.json": "{}" }));
    await svc.addPalSchemaMod("srv1", "b.zip", makeZip({ "DropMe/raw/b.json": "{}" }));
    await svc.removePalSchemaMod("srv1", "DropMe");
    expect((await readdir(modsDir)).sort()).toEqual(["KeepMe"]);
    await expect(stat(join(instance, PAL_SCHEMA_DLL))).resolves.toBeTruthy();
  });

  it("refuses a delete name that climbs out, or that points inside a mod", async () => {
    await svc.addPalSchemaMod("srv1", "a.zip", makeZip({ "KeepMe/raw/a.json": "{}" }));
    for (const evil of ["../../dlls", "/etc", "..", "a\0b"]) {
      await expect(svc.removePalSchemaMod("srv1", evil), evil).rejects.toThrow();
    }
    // A path INSIDE a mod is refused too — this route deletes a mod, not a file in one.
    await expect(svc.removePalSchemaMod("srv1", "KeepMe/raw")).rejects.toThrow(/not an installed/i);

    await expect(stat(join(instance, PAL_SCHEMA_DLL))).resolves.toBeTruthy();
    expect((await readdir(modsDir)).sort()).toEqual(["KeepMe"]);
    expect(await tree(join(modsDir, "KeepMe"))).toContain("raw/a.json");
  });

  it("refuses to list config outside the mods dir", async () => {
    await svc.addPalSchemaMod("srv1", "m.zip", makeZip({ "Mod/raw/a.json": "{}" }));
    for (const evil of ["../../../../etc", "../../dlls", "/etc"]) {
      await expect(svc.palSchemaModConfigFiles("srv1", evil), evil).rejects.toThrow();
    }
  });

  it("refuses an upload whose mod name climbs out, leaving the install intact", async () => {
    await svc.addPalSchemaMod("srv1", "Good.zip", makeZip({ "GoodMod/raw/a.json": "{}" }));
    // Three ways `..` reaches the destination: a "..zip"/"...zip" filename whose stripped
    // base is "..", a top-level "../" entry, and a "PalSchema/mods/../" marker entry.
    const attempts: Array<[string, Record<string, string>]> = [
      ["..zip", { "junk.json": "{}" }],
      ["...zip", { "junk.json": "{}" }],
      ["evil.zip", { "../pwned.json": "{}" }],
      ["evil.zip", { "PalSchema/mods/../pwned.json": "{}" }],
    ];
    for (const [name, files] of attempts) {
      await expect(svc.addPalSchemaMod("srv1", name, makeZip(files)), name).rejects.toThrow();
    }
    // The seeded mod and PalSchema's DLL both survive every attempt.
    expect((await readdir(modsDir)).sort()).toEqual(["GoodMod"]);
    await expect(stat(join(instance, PAL_SCHEMA_DLL))).resolves.toBeTruthy();
  });

  it("strips the .zip extension case-insensitively so re-upload replaces", async () => {
    // A flat archive is named after the upload; "MyMod.ZIP" must yield "MyMod", not
    // "MyMod.ZIP", or a later "MyMod.zip" would create a second folder.
    await svc.addPalSchemaMod("srv1", "MyMod.ZIP", makeZip({ "a.json": "{}" }));
    expect((await readdir(modsDir)).sort()).toEqual(["MyMod"]);
    await svc.addPalSchemaMod("srv1", "MyMod.zip", makeZip({ "b.json": "{}" }));
    expect((await readdir(modsDir)).sort()).toEqual(["MyMod"]);
    expect(await tree(join(modsDir, "MyMod"))).toEqual(["b.json"]);
  });

  it("refuses an archive that mixes root JSON with mod folders", async () => {
    await expect(
      svc.addPalSchemaMod("srv1", "m.zip", makeZip({ "ModA/raw/a.json": "{}", "settings.jsonc": "{}" })),
    ).rejects.toThrow(/loose .*files at its root/i);
    // Nothing partial left on disk.
    expect(await tree(modsDir)).toEqual([]);
  });

  it("install preserves the operator's existing content mods", async () => {
    // A prior content mod the operator installed.
    await svc.addPalSchemaMod("srv1", "keep.zip", makeZip({ "KeepMe/raw/a.json": "{}" }));
    // A PalSchema release zip: its root IS the PalSchema folder.
    const release = makeZip({
      "PalSchema/dlls/main.dll": "MZ",
      "PalSchema/enabled.txt": "",
      "PalSchema/settings.json": "{}",
    });
    await svc.installPalSchema("srv1", release);
    // New DLL is in place AND the operator's mod survived the swap.
    await expect(stat(join(instance, PAL_SCHEMA_DLL))).resolves.toBeTruthy();
    expect((await readdir(modsDir)).sort()).toEqual(["KeepMe"]);
    // No staging dir left behind.
    expect((await readdir(instance)).filter((e) => e.startsWith(".palschema-install-"))).toEqual([]);
  });

  it("install rejects a zip that isn't PalSchema without touching the live dir", async () => {
    await svc.addPalSchemaMod("srv1", "keep.zip", makeZip({ "KeepMe/raw/a.json": "{}" }));
    await expect(
      svc.installPalSchema("srv1", makeZip({ "NotPalSchema/readme.txt": "x" })),
    ).rejects.toThrow(/is this actually a PalSchema release zip/i);
    // The existing install is untouched and no staging dir remains.
    expect((await readdir(modsDir)).sort()).toEqual(["KeepMe"]);
    expect((await readdir(instance)).filter((e) => e.startsWith(".palschema-install-"))).toEqual([]);
  });
}); 
