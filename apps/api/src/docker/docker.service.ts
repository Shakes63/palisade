import { Injectable, Logger } from "@nestjs/common";
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { loadEnv } from "../config/env";

export interface RunResult {
  exitCode: number;
  log: string;
}

/** Strip ANSI colour/escape sequences so log lines render cleanly in the UI. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

/**
 * Which of a server's labelled containers to inspect for live networking. A running
 * one always wins: a stopped container has no IP and isn't in Docker's DNS, and more
 * than one can carry the label (an adoption leaves the original behind, stopped).
 * Returns null when there is nothing labelled for that server.
 */
export function pickServerContainer(list: Array<{ Id: string; State?: string }>): string | null {
  return (list.find((c) => c.State === "running") ?? list[0])?.Id ?? null;
}

/** Demultiplex Docker's non-TTY log buffer (8-byte frame header per chunk). */
function demuxLog(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = Math.min(start + len, buf.length);
    out += buf.toString("utf8", start, end);
    i = end;
  }
  return out || buf.toString("utf8"); // fall back if it wasn't framed
}

export interface ContainerResourceStats {
  cpuPercent: number;
  memUsedMb: number;
  memLimitMb: number;
}

interface RawStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { inactive_file?: number; total_inactive_file?: number; cache?: number };
  };
}

/** Compute CPU% + memory (used/limit, MB) from a Docker one-shot stats payload.
 *  CPU% is expressed as a share of the WHOLE machine (max 100%), matching Unraid's
 *  dashboard and our host CPU% — NOT `docker stats`' per-core figure (which is this
 *  × the core count, so up to 800% on 8 cores). Memory = usage minus reclaimable
 *  page cache. Returns null if stats are absent. */
export function computeContainerStats(s: RawStats): ContainerResourceStats | null {
  const mem = s?.memory_stats;
  if (!mem || typeof mem.usage !== "number") return null;
  const cache =
    mem.stats?.inactive_file ?? mem.stats?.total_inactive_file ?? mem.stats?.cache ?? 0;
  const memUsed = Math.max(0, mem.usage - cache);
  // system_cpu_usage already spans all cores, so cpuDelta/sysDelta is the fraction
  // of total machine CPU this container used — no × cores.
  const cpuDelta =
    (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta =
    (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * 100 : 0;
  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memUsedMb: Math.round(memUsed / 1048576),
    memLimitMb: Math.round((mem.limit ?? 0) / 1048576),
  };
}

/**
 * Thin wrapper over dockerode. Connects to Docker via DOCKER_HOST: the host's
 * unix socket by default (unix:///var/run/docker.sock, mounted into the
 * container), or a tcp socket-proxy (tcp://...) for least-privilege setups
 * (PLANNING.md → Security).
 */
@Injectable()
export class DockerService {
  private readonly logger = new Logger(DockerService.name);
  private readonly docker: Docker;

  constructor() {
    const url = new URL(loadEnv().DOCKER_HOST);
    if (url.protocol === "unix:") {
      this.docker = new Docker({ socketPath: url.pathname });
    } else {
      this.docker = new Docker({ host: url.hostname, port: Number(url.port || 2375) });
    }
  }

  get client(): Docker {
    return this.docker;
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch (err) {
      this.logger.warn(`Docker ping failed: ${(err as Error).message}`);
      return false;
    }
  }

  async pullImage(image: string): Promise<void> {
    this.logger.log(`Pulling image ${image}`);
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err as Error);
        this.docker.modem.followProgress(stream, (e: unknown) =>
          e ? reject(e as Error) : resolve(),
        );
      });
    });
  }

  /**
   * The registry digest of the locally-pulled image, from its RepoDigests
   * ("repo@sha256:…"). Null when the image isn't present or was built locally
   * (no digest). Compared against the registry's current digest to spot a new
   * image for games whose server is baked in (GH #26).
   */
  async imageDigest(ref: string): Promise<string | null> {
    const repo = ref.split(":")[0];
    try {
      const info = await this.docker.getImage(ref).inspect();
      const digests = (info.RepoDigests ?? []) as string[];
      // Multiple entries when the image is tagged for several repos — take ours.
      const mine = digests.find((d) => d.startsWith(`${repo}@`)) ?? digests[0];
      return mine?.split("@")[1] ?? null;
    } catch {
      return null;
    }
  }

  /** Whether an image is already present locally (no registry round-trip). */
  async imageExists(image: string): Promise<boolean> {
    return this.docker
      .getImage(image)
      .inspect()
      .then(() => true)
      .catch(() => false);
  }

  async getContainer(id: string) {
    return this.docker.getContainer(id);
  }

  /** Every container on the host (managed or not) — used by adoption discovery. */
  async listAllContainers(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({ all: true });
  }

  /** All manager-spawned server containers (running or not), keyed for reconcile. */
  async listManagedServers(): Promise<
    Array<{ id: string; serverId: string; running: boolean; status: string }>
  > {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: ["ark.role=server"] },
    });
    return list.map((c) => ({
      id: c.Id,
      serverId: (c.Labels ?? {})["ark.serverId"] ?? "",
      running: c.State === "running",
      status: c.Status,
    }));
  }

  /**
   * Running server containers with their writable-layer size (SizeRw) — the
   * bytes written INSIDE the container fs (docker.img on Unraid), which for our
   * bind-mounted games should stay small. Size computation makes the daemon
   * stat the layer, so callers should keep this to an infrequent sweep.
   */
  async listServerContainerSizes(): Promise<
    Array<{ containerId: string; serverId: string | null; sizeRw: number }>
  > {
    const list = (await this.docker.listContainers({
      filters: { label: ["ark.role=server"] },
      // dockerode types omit it, but the engine API supports ?size=1 on list.
      ...({ size: true } as object),
    })) as Array<Docker.ContainerInfo & { SizeRw?: number }>;
    return list.map((c) => ({
      containerId: c.Id,
      serverId: (c.Labels ?? {})["ark.serverId"] || null,
      sizeRw: c.SizeRw ?? 0,
    }));
  }

  /** One-shot (non-follow) log grab, for scanning readiness during reconcile. */
  async tailLogs(id: string, tail = 2000): Promise<string> {
    const buf = (await this.docker.getContainer(id).logs({
      follow: false,
      stdout: true,
      stderr: true,
      tail,
    })) as unknown as Buffer;
    return stripAnsi(demuxLog(buf));
  }

  async createContainer(opts: Docker.ContainerCreateOptions): Promise<string> {
    const c = await this.docker.createContainer(opts);
    return c.id;
  }

  async start(id: string): Promise<void> {
    await this.docker.getContainer(id).start();
  }

  async stop(id: string, timeoutSeconds = 60): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: timeoutSeconds });
    } catch (err) {
      // already stopped → ignore 304
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }

  async remove(id: string, force = true): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  /** Rename a container in place (so the Unraid dashboard + bridge RCON host
   *  track a server rename without a restart). Cosmetic — matched by label. */
  async rename(id: string, name: string): Promise<void> {
    await this.docker.getContainer(id).rename({ name });
  }

  /** One-shot CPU% + memory (used/limit) for a running container, or null. */
  async stats(id: string): Promise<ContainerResourceStats | null> {
    try {
      const raw = (await this.docker
        .getContainer(id)
        .stats({ stream: false })) as unknown as RawStats;
      return computeContainerStats(raw);
    } catch {
      return null;
    }
  }

  /** Remove a server's container(s) by the ark.serverId label — robust to the
   *  container's (now human-readable, renameable) name. */
  async removeByServerId(serverId: string, force = true): Promise<void> {
    const list = await this.docker
      .listContainers({ all: true, filters: { label: [`ark.serverId=${serverId}`] } })
      .catch(() => [] as Docker.ContainerInfo[]);
    for (const c of list) {
      await this.docker.getContainer(c.Id).remove({ force }).catch(() => undefined);
    }
  }

  /**
   * Whether a Docker network of this exact name exists — or null when we could not
   * find out (a socket-proxy with NETWORKS=0 denies the list). Null matters: callers
   * must not treat "couldn't ask" as "missing", or a locked-down but perfectly
   * working install would be blocked from starting servers (GH #31).
   */
  async networkExists(name: string): Promise<boolean | null> {
    try {
      const list = await this.docker.listNetworks({ filters: { name: [name] } });
      // The name filter is a substring match, so confirm an exact hit.
      return list.some((n: { Name?: string }) => n.Name === name);
    } catch (err) {
      this.logger.debug(`could not list networks (${(err as Error).message})`);
      return null;
    }
  }

  /**
   * Create a user-defined bridge network, ignoring a concurrent create that won it.
   * Returns false when Docker refuses (a socket-proxy with NETWORKS=0, or no
   * permission) so the caller can fall back to telling the user to make it (GH #31).
   */
  async createBridgeNetwork(name: string): Promise<boolean> {
    try {
      await this.docker.createNetwork({ Name: name, Driver: "bridge", CheckDuplicate: true });
      this.logger.log(`Created Docker network ${name}`);
      return true;
    } catch (err) {
      // Someone else created it between our check and this call — that's success.
      if (await this.networkExists(name)) return true;
      this.logger.warn(`Could not create Docker network ${name}: ${(err as Error).message}`);
      return false;
    }
  }

  /** A server's container id by the ark.serverId label — like removeByServerId, robust
   *  to renames. */
  async findContainerIdByServerId(serverId: string): Promise<string | null> {
    const list = await this.docker
      .listContainers({ all: true, filters: { label: [`ark.serverId=${serverId}`] } })
      .catch(() => [] as Docker.ContainerInfo[]);
    return pickServerContainer(list);
  }

  async inspect(id: string) {
    return this.docker.getContainer(id).inspect();
  }

  /** Tail logs; calls onLine for each line. Returns a stop() function. */
  async followLogs(
    id: string,
    onLine: (line: string) => void,
    tail: number = 200,
  ): Promise<() => void> {
    const container = this.docker.getContainer(id);
    const stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail, // 0 = only new lines (used to watch for a fresh "World Save Complete")
    })) as unknown as NodeJS.ReadableStream;

    const out = new PassThrough();
    // A container exiting resets its log socket (ECONNRESET). Without an 'error'
    // listener on BOTH the raw docker stream and the demux output, Node throws an
    // unhandled 'error' event and crashes the entire manager process — which is
    // exactly what happened mid-stop (the container died while this stream was
    // still attached). Swallow it: losing trailing lines from a dying container
    // is fine; crashing the manager is not.
    const onStreamErr = (e: Error) =>
      this.logger.debug(`log stream for ${id} ended: ${e.message}`);
    stream.on("error", onStreamErr);
    out.on("error", onStreamErr);
    container.modem.demuxStream(stream, out, out);
    let buffer = "";
    out.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(stripAnsi(line));
      }
    });
    return () => {
      try {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        /* noop */
      }
    };
  }

  /**
   * Run a short-lived container to completion, streaming its output. Used for the
   * ephemeral SteamCMD installer (PLANNING.md → Install execution).
   */
  async runToCompletion(
    opts: Docker.ContainerCreateOptions,
    onLine?: (line: string) => void,
  ): Promise<RunResult> {
    const container = await this.docker.createContainer({ ...opts, Tty: false });
    let log = "";
    try {
      const stream = (await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      })) as unknown as NodeJS.ReadableStream;
      const out = new PassThrough();
      const onStreamErr = (e: Error) =>
        this.logger.debug(`attach stream ended: ${e.message}`); // never crash on reset
      stream.on("error", onStreamErr);
      out.on("error", onStreamErr);
      container.modem.demuxStream(stream, out, out);
      out.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        log += text;
        if (onLine) for (const line of text.split("\n")) if (line) onLine(line);
      });

      await container.start();
      const status = await container.wait();
      return { exitCode: status.StatusCode ?? -1, log };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }
}
