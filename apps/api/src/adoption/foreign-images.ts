import type Docker from "dockerode";
import { readdir, rename } from "node:fs/promises";
import { Game } from "@ark/shared";
import { splitImageRef } from "../common/images";

/**
 * A game-server image we DON'T run, whose saves we know how to lift into ours
 * (GH #90). Adoption's default copy pairs the two containers by container path,
 * which only works when both run the same image. Unraid mostly runs ich777's
 * SteamCMD wrapper, which keeps everything under /serverdata, while we run
 * thijsvanloef (/palworld) and trueosiris (/mnt/vrising/…), so nothing pairs
 * up and the adopted server comes out empty.
 *
 * `paths` translates between the two: OUR container path → THEIRS. What we
 * list on our side is what `LocalPaths.saveSubpaths(game)` captures in a backup,
 * so an adoption leaves an instance holding exactly what a restore would.
 * Game files are deliberately absent — both images install via SteamCMD on
 * boot, and a Wine prefix or Steam install does not survive the trip.
 *
 * Adding an image: read its start script for where the server writes saves
 * (`docker run --rm --entrypoint sh <image> -c 'cat /opt/scripts/start-server.sh'`
 * for the ich777 family), then map our save subpath onto it.
 */
export interface ForeignImage {
  game: Game;
  /** Where the foreign image keeps our data: our container path → theirs. */
  paths: Record<string, string>;
  /** Shown in the adopt list so the user knows the data is being translated. */
  label: string;
}

/** Keyed by full image ref — the ich777 repo carries one game per tag. */
export const FOREIGN_IMAGES: Readonly<Record<string, ForeignImage>> = {
  // ich777's wrapper installs Palworld into SERVER_DIR, so its saves sit at the
  // same Pal/Saved offset thijsvanloef has under /palworld. Copying the whole
  // Saved dir (not just SaveGames) keeps GameUserSettings.ini with it, and that
  // file names the save folder the server loads.
  "ghcr.io/ich777/steamcmd:palworld": {
    game: Game.PALWORLD,
    paths: { "/palworld/Pal/Saved": "/serverdata/serverfiles/Pal/Saved" },
    label: "ich777 Palworld",
  },
  // Its V Rising start line is `wine64 VRisingServer.exe -persistentDataPath
  // ${SERVER_DIR}/save-data`, which is the Settings/ + Saves/ pair trueosiris
  // mounts at /mnt/vrising/persistentdata.
  "ghcr.io/ich777/steamcmd:vrising": {
    game: Game.VRISING,
    paths: { "/mnt/vrising/persistentdata": "/serverdata/serverfiles/save-data" },
    label: "ich777 V Rising",
  },
};

/** The foreign-image mapping for a container's image, if we have one. */
export function foreignImageFor(ref: string): ForeignImage | undefined {
  const { repo, tag } = splitImageRef(ref);
  const bare = repo.replace(/^(index\.)?docker\.io\//, "");
  return FOREIGN_IMAGES[`${repo}:${tag}`] ?? FOREIGN_IMAGES[`${bare}:${tag}`];
}

/**
 * Split a container path into the bind that holds it and the rest of the path,
 * e.g. /serverdata/serverfiles/save-data against a /serverdata bind gives the
 * host dir plus "serverfiles/save-data". The longest matching bind wins, since
 * a container can mount both a dir and something beneath it. Returns null when
 * no bind covers the path (that data isn't persisted, so there's nothing to
 * copy).
 */
export function resolveBind(
  binds: Record<string, string>,
  containerPath: string,
): { hostRoot: string; subpath: string } | null {
  let best: string | null = null;
  for (const mount of Object.keys(binds)) {
    if (containerPath !== mount && !containerPath.startsWith(`${mount}/`)) continue;
    if (!best || mount.length > best.length) best = mount;
  }
  if (!best) return null;
  return { hostRoot: binds[best]!, subpath: containerPath.slice(best.length).replace(/^\/+/, "") };
}

/** How the copy helper is asked to move one dir into another. */
export interface CopyRequest {
  /** Image to run the helper in — the foreign one, already pulled on this host. */
  image: string;
  /** Bind roots on the host. Only these are mounted, never the subpaths. */
  srcHost: string;
  dstHost: string;
  /** Where inside each bind the data lives ("." for the root itself). */
  srcSub: string;
  dstSub: string;
  /** uid:gid the destination must end up owned by, when the images disagree. */
  own?: { uid: number; gid: number };
}

/** Exit code the helper uses for "the source dir isn't there", which is a skip
 *  (the old server never wrote that data) rather than a failed adoption. */
export const COPY_NO_SOURCE = 90;

/**
 * The helper container that performs one copy.
 *
 * Only the two bind ROOTS are mounted, and the subpaths are resolved inside the
 * container: Docker creates a missing bind source as an empty root-owned dir,
 * which would litter the user's appdata and hand the new instance dirs its
 * server can't write. Subpaths travel as env vars so no path is ever spliced
 * into the shell. The source is read-only, and the helper gets no network.
 */
export function copyHelperSpec(req: CopyRequest): Docker.ContainerCreateOptions {
  const script =
    `[ -d "/palisade-adopt-src/$SRC_SUB" ] || exit ${COPY_NO_SOURCE}; ` +
    'mkdir -p "/palisade-adopt-dst/$DST_SUB" && ' +
    'cp -a "/palisade-adopt-src/$SRC_SUB/." "/palisade-adopt-dst/$DST_SUB/"' +
    (req.own ? ' && chown -R "$OWN" "/palisade-adopt-dst/$DST_SUB"' : "");
  return {
    Image: req.image,
    Entrypoint: ["sh", "-c"],
    Cmd: [script],
    Env: [
      `SRC_SUB=${req.srcSub}`,
      `DST_SUB=${req.dstSub}`,
      ...(req.own ? [`OWN=${req.own.uid}:${req.own.gid}`] : []),
    ],
    Labels: { "ark.role": "adopt-helper" },
    HostConfig: {
      Binds: [`${req.srcHost}:/palisade-adopt-src:ro`, `${req.dstHost}:/palisade-adopt-dst`],
      NetworkMode: "none",
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 256,
    },
  };
}

/**
 * V Rising loads exactly the world named by WORLDNAME, which our spec pins to
 * world1, so a save made under any other name sits in the instance ignored and
 * the server starts an empty one. Both ich777 and trueosiris default to world1,
 * so most adopted saves just work; rename a single differently-named world to
 * cover the rest. Two or more and we can't know which they meant, so they stay
 * as they are. Returns the names it renamed.
 *
 * `instanceRoot` is the manager's own view of the dir (LocalPaths), since this
 * runs after the helper container has put the files there.
 */
export async function alignVRisingWorldName(instanceRoot: string): Promise<string[]> {
  const saves = `${instanceRoot}/persistentdata/Saves`;
  const renamed: string[] = [];
  // Saves/<version>/<world>, and the version dir moves with the game (v3, v4…).
  for (const version of await readdir(saves).catch(() => [] as string[])) {
    const dir = `${saves}/${version}`;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const worlds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (worlds.length !== 1 || worlds[0] === "world1") continue;
    await rename(`${dir}/${worlds[0]}`, `${dir}/world1`);
    renamed.push(worlds[0]!);
  }
  return renamed;
}
