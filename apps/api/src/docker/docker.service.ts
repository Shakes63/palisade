import { Injectable, Logger } from "@nestjs/common";
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { loadEnv } from "../config/env";

export interface RunResult {
  exitCode: number;
  log: string;
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

  async getContainer(id: string) {
    return this.docker.getContainer(id);
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

  /** One-shot (non-follow) log grab, for scanning readiness during reconcile. */
  async tailLogs(id: string, tail = 2000): Promise<string> {
    const buf = (await this.docker.getContainer(id).logs({
      follow: false,
      stdout: true,
      stderr: true,
      tail,
    })) as unknown as Buffer;
    return buf.toString("utf8");
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

  async inspect(id: string) {
    return this.docker.getContainer(id).inspect();
  }

  /** Tail logs; calls onLine for each line. Returns a stop() function. */
  async followLogs(id: string, onLine: (line: string) => void): Promise<() => void> {
    const container = this.docker.getContainer(id);
    const stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,
    })) as unknown as NodeJS.ReadableStream;

    const out = new PassThrough();
    container.modem.demuxStream(stream, out, out);
    let buffer = "";
    out.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
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
