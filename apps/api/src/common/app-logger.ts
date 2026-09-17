import { ConsoleLogger } from "@nestjs/common";
import type { LogLevel } from "@ark/shared";

// A Nest Logger only forwards to an app-wide logger when one is installed;
// otherwise each service snapshots the levels on first use and a later change
// never reaches it.
export const appLogger = new ConsoleLogger();

export function setLogLevel(level: LogLevel): void {
  // Nest enables everything at or above the highest level in the list.
  appLogger.setLogLevels([level]);
}
