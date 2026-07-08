import { Injectable } from "@nestjs/common";

/** Max lines kept per channel per server — covers a full boot plus recent runtime
 *  without unbounded memory. Also the seed depth from `docker logs`. */
export const LOG_CAPTURE_MAX = 5000;

/**
 * Per-server, per-run capture of the container log and the console (log + RCON
 * I/O) streams, so the UI shows the whole current run regardless of whether a tab
 * was open, and survives refreshes/tab switches. Wiped when a new run starts.
 * In-memory + bounded; re-seeded from `docker logs` when a server is adopted after
 * a manager restart.
 */
@Injectable()
export class LogCaptureService {
  private readonly logs = new Map<string, string[]>();
  private readonly console = new Map<string, string[]>();
  private readonly lineListeners = new Set<(serverId: string, line: string) => void>();

  /** Subscribe to every captured container log line (e.g. join-message parsing).
   *  Listener errors are swallowed — this sits on the hot log path. */
  onLine(cb: (serverId: string, line: string) => void): void {
    this.lineListeners.add(cb);
  }

  private push(map: Map<string, string[]>, id: string, lines: string[]): void {
    const cur = map.get(id) ?? [];
    cur.push(...lines);
    if (cur.length > LOG_CAPTURE_MAX) cur.splice(0, cur.length - LOG_CAPTURE_MAX);
    map.set(id, cur);
  }

  /** A container log line → both the log and console channels + line listeners. */
  recordLog(id: string, line: string): void {
    this.push(this.logs, id, [line]);
    this.push(this.console, id, [line]);
    for (const cb of this.lineListeners) {
      try {
        cb(id, line);
      } catch {
        /* listeners must not break log capture */
      }
    }
  }

  /** RCON I/O (commands + responses) → the console channel only. */
  recordConsole(id: string, line: string): void {
    this.push(this.console, id, [line]);
  }

  /** Replace both channels with a backlog (the current container log) — used on
   *  (re)attach. A fresh container's log is ~empty, which wipes the run. */
  seed(id: string, lines: string[]): void {
    const trimmed = lines.slice(-LOG_CAPTURE_MAX);
    this.logs.set(id, [...trimmed]);
    this.console.set(id, [...trimmed]);
  }

  clear(id: string): void {
    this.logs.delete(id);
    this.console.delete(id);
  }

  getLogs(id: string): string {
    return (this.logs.get(id) ?? []).join("\n");
  }

  getConsole(id: string): string {
    return (this.console.get(id) ?? []).join("\n");
  }
}
