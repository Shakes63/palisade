import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game, STEAM_APP_ID } from "@ark/shared";
import { InstallerService } from "./installer.service";

// Exercises the reflink cache round-trip end to end against a temp DATA_DIR.
// On macOS/dev BSD `cp` rejects `--reflink`, so this also covers the deep-copy
// fallback path inside cloneTree().

const exists = (p: string) =>
  stat(p)
    .then(() => true)
    .catch(() => false);

const MANIFEST = `appmanifest_${STEAM_APP_ID[Game.ASA]}.acf`;
let tmp: string;
let svc: InstallerService;

/** Build a minimal POK-style install tree under instances/<id>. */
async function fakeInstall(root: string, worldTag: string) {
  await mkdir(join(root, "ShooterGame", "Binaries"), { recursive: true });
  await writeFile(join(root, "ShooterGame", "Binaries", "server.bin"), "BIN");
  await mkdir(join(root, "ShooterGame", "Saved", "SavedArks"), { recursive: true });
  await writeFile(join(root, "ShooterGame", "Saved", "SavedArks", "world.ark"), worldTag);
  await mkdir(join(root, "instance_flags"), { recursive: true });
  await writeFile(join(root, "instance_flags", "first_startup_complete"), "");
  await writeFile(join(root, MANIFEST), "manifest");
  await writeFile(join(root, "palisade-server.json"), "{}");
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ark-cache-"));
  process.env.DATA_DIR = tmp;
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  const events = { emit: async () => undefined };
  svc = new InstallerService({} as never, events as never, {} as never);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ASA game-file cache", () => {
  it("seeds a clean golden copy (no per-server world or POK state)", async () => {
    const instA = join(tmp, "instances", "srvA");
    await fakeInstall(instA, "WORLD-A");

    await svc.seedGameFilesCache("srvA", Game.ASA);

    const cache = join(tmp, "cache", "asa");
    expect(await exists(join(cache, "ShooterGame", "Binaries", "server.bin"))).toBe(true);
    expect(await exists(join(cache, MANIFEST))).toBe(true);
    // Per-server world + POK runtime state are pruned from the golden copy.
    expect(await exists(join(cache, "ShooterGame", "Saved"))).toBe(false);
    expect(await exists(join(cache, "instance_flags"))).toBe(false);
    expect(await exists(join(cache, "palisade-server.json"))).toBe(false);
  });

  it("restores a new instance from the cache without its own world", async () => {
    await svc.prepareGameFiles("srvB", Game.ASA);

    const instB = join(tmp, "instances", "srvB");
    expect(await readFile(join(instB, "ShooterGame", "Binaries", "server.bin"), "utf8")).toBe("BIN");
    expect(await exists(join(instB, MANIFEST))).toBe(true);
    // Each server starts with a fresh world, not the seeding server's save.
    expect(await exists(join(instB, "ShooterGame", "Saved"))).toBe(false);
  });

  it("is a no-op when the instance is already installed", async () => {
    const instC = join(tmp, "instances", "srvC");
    await fakeInstall(instC, "WORLD-C");

    await svc.prepareGameFiles("srvC", Game.ASA);

    // The instance's own world must be left untouched (not clobbered by the cache).
    expect(await readFile(join(instC, "ShooterGame", "Saved", "SavedArks", "world.ark"), "utf8")).toBe(
      "WORLD-C",
    );
  });

  it("does not seed twice once the cache is warm", async () => {
    const before = await readFile(join(tmp, "cache", "asa", "ShooterGame", "Binaries", "server.bin"), "utf8");
    // A second server readies, but the cache is already warm → seed is skipped.
    const instD = join(tmp, "instances", "srvD");
    await fakeInstall(instD, "WORLD-D");
    await svc.seedGameFilesCache("srvD", Game.ASA);
    const after = await readFile(join(tmp, "cache", "asa", "ShooterGame", "Binaries", "server.bin"), "utf8");
    expect(after).toBe(before);
  });

  it("ignores ASE (it uses a shared install dir already)", async () => {
    await svc.prepareGameFiles("srvE", Game.ASE);
    await svc.seedGameFilesCache("srvE", Game.ASE);
    expect(await exists(join(tmp, "cache", "ase"))).toBe(false);
  });
});
