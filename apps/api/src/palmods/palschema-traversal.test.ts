import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game } from "@ark/shared";
import { PalModsService, PAL_SCHEMA_DLL, PAL_FRAMEWORK_WINE_LOADER } from "./palmods.service";

/**
 * Regression guard for the addPalSchemaMod traversal (PR #93 review, blocker):
 * plan names/sources derived from an uploaded archive must not let `..` escape the
 * mods directory, or the wholesale `rm(dest)` would take the whole PalSchema install
 * with it. All three vectors — a `..zip` filename, a `../` entry, and a
 * `PalSchema/mods/../` entry — must be refused, and the previously-installed mod must
 * survive untouched.
 */
describe("addPalSchemaMod path containment", () => {
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
      lfh.writeUInt16LE(20, 4);
      lfh.writeUInt16LE(0, 8);
      lfh.writeUInt32LE(crc, 14);
      lfh.writeUInt32LE(data.length, 18);
      lfh.writeUInt32LE(data.length, 22);
      lfh.writeUInt16LE(name.length, 26);
      locals.push(lfh, name, data);
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);
      cdh.writeUInt16LE(20, 4);
      cdh.writeUInt16LE(20, 6);
      cdh.writeUInt16LE(0, 10);
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

  const palSchemaDir = () => join(instance, "Pal/Binaries/Win64/Mods/PalSchema");

  it("keeps the install intact when the exploit is rejected", async () => {
    // Seed a good mod so we can prove it — and the PalSchema DLL — survive each attempt.
    await svc.addPalSchemaMod("srv1", "Good.zip", makeZip({ "GoodMod/raw/a.json": "{}" }));
    expect((await readdir(modsDir)).sort()).toEqual(["GoodMod"]);

    const attempts: Array<[string, Record<string, string>]> = [
      // basename("..zip", ".zip") === ".." → fallbackName escapes to Mods/PalSchema/mods/..
      ["..zip", { "junk.json": "{}" }],
      // basename("...zip", ".zip") === "..." — resolves above the mods dir
      ["...zip", { "junk.json": "{}" }],
      // top-level "../" folder in a plain archive
      ["evil.zip", { "../pwned.json": "{}" }],
      // the marker branch reading ".." out of PalSchema/mods/<name>
      ["evil.zip", { "PalSchema/mods/../pwned.json": "{}" }],
    ];

    for (const [name, files] of attempts) {
      await expect(svc.addPalSchemaMod("srv1", name, makeZip(files))).rejects.toThrow();
    }

    // The seeded mod, the mods dir, and the DLL are all still there.
    expect((await readdir(modsDir)).sort()).toEqual(["GoodMod"]);
    expect(await stat(join(instance, PAL_SCHEMA_DLL)).then(() => true).catch(() => false)).toBe(true);
    expect(await readdir(palSchemaDir())).toContain("dlls");
  });
});
