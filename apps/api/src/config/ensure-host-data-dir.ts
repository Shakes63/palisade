import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import Docker from "dockerode";
import { resetEnvCache } from "./env";

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
 *
 * When it IS set explicitly, that value still wins, but we compare it against the real
 * mount and warn on a disagreement: a stale/mistyped value silently scatters game
 * servers into a directory the user never chose, which is baffling from the outside
 * (GH #29 — files appeared under the old default instead of the configured App data).
 */
export async function ensureHostDataDir(log: (msg: string) => void = console.log): Promise<void> {
  const configured = process.env.HOST_DATA_DIR;
  const dataDir = process.env.DATA_DIR || "/data";
  try {
    const docker = connect();
    const id = await findSelfContainerId(docker);
    if (!id) return;
    const info = await docker.getContainer(id).inspect();
    const mount = (info.Mounts ?? []).find((m) => m.Destination === dataDir);
    const detected = mount?.Source;
    if (!detected) return;
    detectedPath = detected;

    const action = hostDataDirAction(configured, detected);
    if (action.kind === "adopt") {
      process.env.HOST_DATA_DIR = action.value;
      log(`[host-data-dir] auto-detected HOST_DATA_DIR=${action.value} from the manager's own ${dataDir} mount`);
    } else if (action.kind === "mismatch") {
      mismatch = { configured: action.configured, detected: action.detected };
      log(`[host-data-dir] WARNING: ${mismatchMessage(action.configured, action.detected, dataDir)}`);
    }
  } catch (e) {
    log(`[host-data-dir] auto-detect skipped (${(e as Error).message}) — falling back to DATA_DIR`);
  }
}

/**
 * What to do with an explicitly-set HOST_DATA_DIR once we know where /data really
 * comes from. An explicit value always wins (someone may have a bind layout we can't
 * model) — but a disagreement is worth shouting about, because the only symptom is
 * game files appearing in a directory the user never chose (GH #29).
 */
export type HostDataDirAction =
  | { kind: "adopt"; value: string }
  | { kind: "mismatch"; configured: string; detected: string }
  | { kind: "ok" };

export function hostDataDirAction(configured: string | undefined, detected: string): HostDataDirAction {
  if (!configured) return { kind: "adopt", value: detected };
  return samePath(configured, detected) ? { kind: "ok" } : { kind: "mismatch", configured, detected };
}

/** The operator-facing explanation, shared by the boot log and /api/health. */
export function mismatchMessage(configured: string, detected: string, dataDir = "/data"): string {
  return (
    `HOST_DATA_DIR is set to "${configured}", but this container's ${dataDir} actually comes from ` +
    `"${detected}". Game servers will be created under "${configured}" — not where you pointed App data. ` +
    `Clear HOST_DATA_DIR to auto-detect it, or set it to "${detected}".`
  );
}

/** Same host path, ignoring a trailing slash. */
export function samePath(a: string, b: string): boolean {
  const trim = (p: string) => p.replace(/\/+$/, "");
  return trim(a) === trim(b);
}

let mismatch: { configured: string; detected: string } | null = null;
/** Where /data really comes from, remembered so a HOST_DATA_DIR set later (from the
 *  Settings page) can be re-checked against it without another Docker round-trip. */
let detectedPath: string | null = null;

/**
 * Apply a HOST_DATA_DIR chosen in the UI, without a restart.
 *
 * paths.ts resolves the host root per call rather than at import, so writing it into
 * the environment is enough for the next container Palisade creates — the same
 * mechanism boot-time auto-detection already uses. A null value means "go back to
 * the auto-detected path", which is what clearing the field should do.
 *
 * Re-evaluates the GH #29 mismatch warning too, so correcting the path in the UI
 * clears the banner instead of leaving it up until the next restart.
 */
export function applyHostDataDirOverride(value: string | null): void {
  const chosen = value?.trim() || null;
  if (chosen) process.env.HOST_DATA_DIR = chosen;
  else if (detectedPath) process.env.HOST_DATA_DIR = detectedPath;
  else delete process.env.HOST_DATA_DIR;
  resetEnvCache();

  if (!detectedPath) return; // nothing to compare against; leave any warning as-is
  const action = hostDataDirAction(chosen ?? undefined, detectedPath);
  mismatch = action.kind === "mismatch" ? { configured: action.configured, detected: action.detected } : null;
}

/** Set when HOST_DATA_DIR disagrees with the manager's real /data mount, so the
 *  health endpoint can surface the same warning the boot log printed (GH #29). */
export function hostDataDirMismatch(): { configured: string; detected: string } | null {
  return mismatch;
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
