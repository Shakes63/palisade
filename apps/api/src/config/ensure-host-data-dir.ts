import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import Docker from "dockerode";

/**
 * Auto-detect HOST_DATA_DIR — the host-side path of the manager's /data mount, which
 * the manager needs to bind-mount data into the game-server containers it spawns.
 *
 * It MUST equal the "App data" path the user set on the Palisade container, and keeping
 * a second field in sync by hand is a classic footgun: change the appdata path, forget
 * this, and every spawned game server bind-mounts the wrong host dir and breaks with a
 * baffling error. So if it isn't set explicitly, we ask Docker for the Source of our own
 * /data mount and use that.
 *
 * Runs BEFORE loadEnv (which caches env), and is entirely best-effort: any failure —
 * no socket, a locked-down socket-proxy, running outside Docker — just leaves it unset,
 * and paths.ts falls back to DATA_DIR (correct whenever the two coincide, as they do by
 * default). Never throws.
 */
export async function ensureHostDataDir(log: (msg: string) => void = console.log): Promise<void> {
  if (process.env.HOST_DATA_DIR) return; // explicit value wins
  const dataDir = process.env.DATA_DIR || "/data";
  try {
    const docker = connect();
    const id = await findSelfContainerId(docker);
    if (!id) return;
    const info = await docker.getContainer(id).inspect();
    const mount = (info.Mounts ?? []).find((m) => m.Destination === dataDir);
    if (mount?.Source) {
      process.env.HOST_DATA_DIR = mount.Source;
      log(`[host-data-dir] auto-detected HOST_DATA_DIR=${mount.Source} from the manager's own ${dataDir} mount`);
    }
  } catch (e) {
    log(`[host-data-dir] auto-detect skipped (${(e as Error).message}) — falling back to DATA_DIR`);
  }
}

/** Same DOCKER_HOST parsing as DockerService, but reads process.env directly (pre-loadEnv). */
function connect(): Docker {
  const url = new URL(process.env.DOCKER_HOST || "unix:///var/run/docker.sock");
  return url.protocol === "unix:"
    ? new Docker({ socketPath: url.pathname })
    : new Docker({ host: url.hostname, port: Number(url.port || 2375) });
}

/** Our own container id: the hostname is the short id by default; if that's been
 *  overridden, the full id still appears in /proc/self/{mountinfo,cgroup}. Each
 *  candidate is confirmed by an inspect() so we never guess wrong. Returns null
 *  when we aren't running in a container at all (dev on the host). */
export async function findSelfContainerId(docker: Docker): Promise<string | null> {
  const candidates: string[] = [];
  const hn = hostname();
  if (/^[0-9a-f]{12,64}$/i.test(hn)) candidates.push(hn);
  for (const path of ["/proc/self/mountinfo", "/proc/self/cgroup"]) {
    try {
      const m = readFileSync(path, "utf8").match(/[0-9a-f]{64}/i);
      if (m) candidates.push(m[0]);
    } catch {
      /* not running in a container / unreadable */
    }
  }
  for (const id of candidates) {
    try {
      await docker.getContainer(id).inspect();
      return id;
    } catch {
      /* not us — try the next candidate */
    }
  }
  return null;
}
