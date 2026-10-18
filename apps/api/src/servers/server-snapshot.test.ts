import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetEnvCache } from "../config/env";
import { LocalPaths } from "../common/paths";
import { readServerSnapshot, SNAPSHOT_FILE, writeServerSnapshot, type ServerSnapshot } from "./server-snapshot";

let dataDir: string;

beforeAll(async () => {
  process.env.SECRETS_KEY = "a".repeat(64);
  process.env.JWT_SECRET = "test-jwt-secret-1234";
  dataDir = await mkdtemp(join(tmpdir(), "palisade-snapshot-"));
  process.env.DATA_DIR = dataDir;
  resetEnvCache();
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));

const snapshot = { version: 1, id: "csnap", game: "MINECRAFT", name: "Snap", mods: [] } as unknown as ServerSnapshot;

describe("writeServerSnapshot", () => {
  it("replaces a symlink the game container planted instead of writing through it", async () => {
    const victim = join(dataDir, "db.sqlite");
    await writeFile(victim, "DATABASE");
    await mkdir(LocalPaths.instanceRoot("csnap"), { recursive: true });
    const path = join(LocalPaths.instanceRoot("csnap"), SNAPSHOT_FILE);
    await symlink(victim, path);

    await writeServerSnapshot("csnap", snapshot);

    expect(await readFile(victim, "utf8")).toBe("DATABASE");
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readServerSnapshot("csnap")).toMatchObject({ id: "csnap", name: "Snap" });
  });

  it("cleans up its temp file when the snapshot can't be replaced", async () => {
    const root = LocalPaths.instanceRoot("cdir");
    await mkdir(join(root, SNAPSHOT_FILE), { recursive: true });
    await expect(writeServerSnapshot("cdir", snapshot)).rejects.toThrow();
    expect(await readdir(root)).toEqual([SNAPSHOT_FILE]);
  });
});

describe("readServerSnapshot", () => {
  it("won't follow a symlink or block on a FIFO the game container planted", async () => {
    const victim = join(dataDir, "elsewhere.json");
    await writeFile(victim, JSON.stringify({ ...snapshot, id: "clink" }));
    await mkdir(LocalPaths.instanceRoot("clink"), { recursive: true });
    await symlink(victim, join(LocalPaths.instanceRoot("clink"), SNAPSHOT_FILE));
    expect(await readServerSnapshot("clink")).toBeNull();

    await mkdir(LocalPaths.instanceRoot("cfifo"), { recursive: true });
    execFileSync("mkfifo", [join(LocalPaths.instanceRoot("cfifo"), SNAPSHOT_FILE)]);
    expect(await readServerSnapshot("cfifo")).toBeNull();
  });

  it("refuses a snapshot over 1 MB", async () => {
    await mkdir(LocalPaths.instanceRoot("cbig"), { recursive: true });
    // Still valid JSON when cut off at the cap, so only the cap itself can refuse it.
    const big = JSON.stringify({ ...snapshot, id: "cbig" }) + " ".repeat(2 * 1024 * 1024);
    await writeFile(join(LocalPaths.instanceRoot("cbig"), SNAPSHOT_FILE), big);
    expect(await readServerSnapshot("cbig")).toBeNull();
  });
});
