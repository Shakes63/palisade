import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetEnvCache } from "../config/env";
import { DockerService } from "../docker/docker.service";
import { COPY_NO_SOURCE, copyHelperSpec } from "./foreign-images";

/**
 * The adoption copy, against a REAL Docker daemon.
 *
 * Everything here is daemon behaviour a fake would happily agree with and get
 * wrong: that a bind source which doesn't exist is CREATED (root-owned) rather
 * than refused, which is why the helper mounts bind roots and resolves subpaths
 * inside; that `cp -a` into a fresh subdir keeps the tree; that the chown lands
 * so a uid-strict game image can write its own saves afterwards. Adopting an
 * ich777 Palworld server is exactly this copy with subpaths on both sides
 * (GH #90), and getting it wrong means an empty or unwritable world.
 *
 * Gated: PALISADE_DOCKER_TESTS=1 is consent to touch the local daemon. Uses
 * alpine, works in a unique temp dir, and removes everything afterwards.
 */
const enabled = process.env.PALISADE_DOCKER_TESTS === "1";
const IMAGE = "alpine:3.20";

let docker: DockerService;
let root: string;

describe.skipIf(!enabled)("adoption copy against a real daemon", () => {
  beforeAll(async () => {
    process.env.SECRETS_KEY ??= randomBytes(32).toString("hex");
    process.env.JWT_SECRET ??= randomBytes(16).toString("hex");
    resetEnvCache();
    docker = new DockerService();
    await docker.pullImage(IMAGE).catch(() => undefined);
    root = await mkdtemp(join(tmpdir(), "palisade-adopt-"));
  });

  afterAll(async () => {
    if (!root) return;
    // The helper copies as root, so the test process can't unlink what it left.
    // Clear it out from a container the same way, then drop the (empty) dir.
    await docker
      .runToCompletion({
        Image: IMAGE,
        Entrypoint: ["sh", "-c"],
        Cmd: ["rm -rf /scrub/* /scrub/.[!.]*"],
        HostConfig: { Binds: [`${root}:/scrub`], NetworkMode: "none" },
      })
      .catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  /** A source laid out like ich777's wrapper: the bind root is /serverdata, and
   *  the saves sit well below it. */
  async function ich777Source(name: string): Promise<string> {
    const src = join(root, name);
    await mkdir(join(src, "serverfiles", "Pal", "Saved", "SaveGames", "0"), { recursive: true });
    await writeFile(join(src, "serverfiles", "Pal", "Saved", "SaveGames", "0", "Level.sav"), "world");
    await writeFile(join(src, "serverfiles", "Pal", "Saved", "GameUserSettings.ini"), "[Pal]\n");
    // Game files that must NOT come across: a 1-file stand-in for the install.
    await writeFile(join(src, "serverfiles", "PalServer.sh"), "#!/bin/sh\n");
    return src;
  }

  it("lifts a save tree out of a foreign layout into ours", async () => {
    const src = await ich777Source("src-a");
    const dst = join(root, "dst-a");
    await mkdir(dst, { recursive: true });

    const res = await docker.runToCompletion(
      copyHelperSpec({
        image: IMAGE,
        srcHost: src,
        dstHost: dst,
        srcSub: "serverfiles/Pal/Saved",
        dstSub: "Pal/Saved",
      }),
    );

    expect(res.exitCode).toBe(0);
    expect(await readFile(join(dst, "Pal/Saved/SaveGames/0/Level.sav"), "utf8")).toBe("world");
    expect(await readFile(join(dst, "Pal/Saved/GameUserSettings.ini"), "utf8")).toBe("[Pal]\n");
    // The install stayed behind — SteamCMD refetches it on first boot.
    await expect(stat(join(dst, "PalServer.sh"))).rejects.toThrow();
    await expect(stat(join(dst, "serverfiles"))).rejects.toThrow();
  });

  it("chowns the copy to the uid the destination image runs as", async () => {
    const src = await ich777Source("src-b");
    const dst = join(root, "dst-b");
    await mkdir(dst, { recursive: true });

    const res = await docker.runToCompletion(
      copyHelperSpec({
        image: IMAGE,
        srcHost: src,
        dstHost: dst,
        srcSub: "serverfiles/Pal/Saved",
        dstSub: "Pal/Saved",
        own: { uid: 1000, gid: 1000 }, // thijsvanloef's "steam"
      }),
    );

    expect(res.exitCode).toBe(0);
    const st = await stat(join(dst, "Pal/Saved/SaveGames/0/Level.sav"));
    expect({ uid: st.uid, gid: st.gid }).toEqual({ uid: 1000, gid: 1000 });
  });

  it("reports a missing source instead of failing, and creates nothing", async () => {
    const src = join(root, "src-c");
    const dst = join(root, "dst-c");
    await mkdir(src, { recursive: true });
    await mkdir(dst, { recursive: true });

    const res = await docker.runToCompletion(
      copyHelperSpec({
        image: IMAGE,
        srcHost: src,
        dstHost: dst,
        srcSub: "serverfiles/save-data", // the old server never started
        dstSub: "persistentdata",
      }),
    );

    expect(res.exitCode).toBe(COPY_NO_SOURCE);
    // Neither side gained a stray dir: the helper never binds a subpath, so the
    // daemon has nothing to auto-create in the user's appdata.
    await expect(stat(join(src, "serverfiles"))).rejects.toThrow();
    await expect(stat(join(dst, "persistentdata"))).rejects.toThrow();
  });

  it("copies a whole bind when the mapping has no subpath", async () => {
    const src = join(root, "src-d");
    const dst = join(root, "dst-d");
    await mkdir(join(src, "Saves", "v4", "world1"), { recursive: true });
    await writeFile(join(src, "Saves", "v4", "world1", "AutoSave.save"), "castle");
    await mkdir(dst, { recursive: true });

    const res = await docker.runToCompletion(
      copyHelperSpec({ image: IMAGE, srcHost: src, dstHost: dst, srcSub: ".", dstSub: "." }),
    );

    expect(res.exitCode).toBe(0);
    expect(await readFile(join(dst, "Saves/v4/world1/AutoSave.save"), "utf8")).toBe("castle");
  });
});
