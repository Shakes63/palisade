import { Game } from "@ark/shared";
import { loadEnv } from "../config/env";

/**
 * Container-side mount targets the game images expect. Both images install the
 * game files themselves into their own volume (POK → /home/pok/arkserver via
 * POK_DATA_DIR, hermsi → /app via HERMSI_VOLUME), so the only shared targets
 * here are the cross-server cluster dirs.
 */
export const ContainerPaths = {
  // Shared cross-server cluster dir mount targets — a path outside each image's
  // per-instance volume so it isn't swallowed by it. All members of a cluster
  // mount the same host dir here and ARK is pointed at it via -ClusterDirOverride.
  pokCluster: "/home/pok/clustershared", // ASA (POK), sibling of /home/pok/arkserver
  hermsiCluster: "/clustershared", // ASE (hermsi), outside /app
} as const;

function hostDataDir(): string {
  const env = loadEnv();
  return env.HOST_DATA_DIR ?? env.DATA_DIR;
}

/**
 * Paths as seen by the **manager process itself** (DATA_DIR), used for direct
 * filesystem work — rendering INIs, reflink-cloning game files. These differ
 * from HostPaths (which are resolved by the Docker daemon for bind mounts);
 * on Unraid the manager sees e.g. /data while the daemon sees /mnt/cache/....
 */
export const LocalPaths = {
  instanceRoot(serverId: string): string {
    return `${loadEnv().DATA_DIR}/instances/${serverId}`;
  },
  /**
   * The save/config subpaths inside an instance that a backup must capture (relative
   * to the instance root). Most games have one; some need several. A subpath that
   * doesn't exist for a given server (e.g. Minecraft's Nether on a vanilla world,
   * where dimensions nest inside `world/`) is simply skipped when snapshotting.
   *
   * ARK: POK/ASA installs at the root → `ShooterGame/Saved`; hermsi/ASE installs
   *   under `server/` → `server/ShooterGame/Saved`. Conan: the SQLite world DB +
   *   Config under `server/ConanSandbox/Saved`. Palworld: `Pal/Saved`. Icarus: the
   *   whole Wine-drive `config` dir (prospects + settings). Minecraft: the world,
   *   plus Paper/Spigot's separate Nether/End sibling folders when present. Bedrock:
   *   all worlds AND the add-on pack folders (they live beside `worlds/`, so a
   *   restore without them would reference missing packs).
   */
  saveSubpaths(game: Game): string[] {
    switch (game) {
      case Game.ASE:
        return ["server/ShooterGame/Saved"];
      case Game.CONAN:
        return ["server/ConanSandbox/Saved"];
      case Game.PALWORLD:
        return ["Pal/Saved"];
      case Game.MINECRAFT:
        return ["world", "world_nether", "world_the_end"];
      case Game.ICARUS:
        return ["config"];
      case Game.BEDROCK:
        return ["worlds", "behavior_packs", "resource_packs"];
      case Game.VALHEIM:
        return ["config/worlds_local"]; // lloesche stores the world .db/.fwl here
      case Game.SEVEN_DAYS:
        return ["saves"]; // the .local/share/7DaysToDie bind (world + player data)
      case Game.ENSHROUDED:
        // The mornedhels image installs the game under /opt/enshrouded/server, so the
        // savegame lands at server/savegame inside the gamefiles bind (verified live).
        return ["gamefiles/server/savegame"];
      case Game.ZOMBOID:
        // The Zomboid data bind: world saves, the server ini/sandbox configs, and the
        // player-accounts database. (Workshop mod downloads + logs are skipped.)
        return ["data/Saves", "data/Server", "data/db"];
      case Game.VRISING:
        // The persistentdata bind: world saves (Saves/) + the two settings JSONs
        // (Settings/). The ~2 GB game install lives in the separate server bind.
        return ["persistentdata"];
      case Game.SOTF:
        // dedicatedserver.cfg + ownerswhitelist + Saves live under userdata inside
        // the single game bind; the ~10 GB install beside it is skipped.
        return ["game/userdata"];
      case Game.SATISFACTORY:
        // Saves + blueprints + server config live under config/saved; the ~10 GB
        // install (config/gamefiles) and the image's own backups dir are skipped.
        return ["config/saved"];
      case Game.LIF:
        // The world lives in the bundled MariaDB's datadir (.database) plus the
        // config dir (world_1.xml). NOTE: a running-server backup of a live MariaDB
        // datadir is crash-consistent only — clean backups happen while stopped.
        return ["serverfiles/.database", "serverfiles/config"];
      default:
        return ["ShooterGame/Saved"]; // ASA (POK)
    }
  },

  /**
   * The primary save dir inside an instance (the first of saveSubpaths) — used by
   * import and anywhere a single dir is needed. Backup/restore iterate saveSubpaths.
   */
  savedDir(serverId: string, game: Game): string {
    return `${this.instanceRoot(serverId)}/${this.saveSubpaths(game)[0]}`;
  },
  /** Warmed golden copy of a game's files, reflink-cloned into each instance. */
  gameCache(game: Game): string {
    return `${loadEnv().DATA_DIR}/cache/${game.toLowerCase()}`;
  },
  /** Shared cluster transfer dir (manager view), mounted into each member. */
  cluster(clusterId: string): string {
    return `${loadEnv().DATA_DIR}/clusters/${clusterId}`;
  },
};

export const HostPaths = {
  instanceRoot(serverId: string): string {
    return `${hostDataDir()}/instances/${serverId}`;
  },
  cluster(clusterId: string): string {
    return `${hostDataDir()}/clusters/${clusterId}`;
  },
  backups(serverId: string): string {
    return `${hostDataDir()}/backups/${serverId}`;
  },
};
