import { Logger } from "@nestjs/common";

/**
 * Socket/network error codes that surface as background stream `'error'` events —
 * docker log streams, RCON connections, webhook posts — typically when the peer
 * (a game container) dies. They do NOT corrupt the manager's own state, so the
 * process should log and keep serving rather than crash. (A single unhandled one
 * of these once took the whole manager down mid-stop; see the stop teardown.)
 */
export const RECOVERABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

export function isRecoverable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && RECOVERABLE_ERROR_CODES.has(code);
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Last-resort process guards. Without these, a single unhandled `'error'` event or
 * promise rejection from a background task crashes the entire API. We:
 *  - log unhandled rejections and keep running,
 *  - swallow uncaught exceptions that are clearly background socket resets,
 *  - and for any OTHER uncaught exception, log it and exit cleanly so Docker's
 *    `restart=unless-stopped` brings us back from a defined state (reconcile then
 *    re-syncs) rather than leaving a half-broken process running.
 */
export function installProcessSafetyNet(logger: Logger = new Logger("Process")): void {
  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled promise rejection (continuing): ${describe(reason)}`);
  });

  process.on("uncaughtException", (err) => {
    if (isRecoverable(err)) {
      logger.error(
        `Recovered from uncaught ${(err as NodeJS.ErrnoException).code} on a background socket: ${err.message}`,
      );
      return;
    }
    logger.error(`Uncaught exception — exiting for a clean restart: ${describe(err)}`);
    process.exit(1);
  });
}
