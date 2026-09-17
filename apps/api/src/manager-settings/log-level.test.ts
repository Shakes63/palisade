import { describe, it, expect } from "vitest";
import { ManagerSettingsService, SettingKeys } from "./manager-settings.service";
import { appLogger, setLogLevel } from "../common/app-logger";

const withRows = (rows: Record<string, string>) =>
  new ManagerSettingsService(
    {
      managerSetting: {
        findUnique: async ({ where }: { where: { key: string } }) =>
          where.key in rows ? { key: where.key, value: rows[where.key], isSecret: false } : null,
      },
    } as never,
    { decrypt: (v: string) => v } as never,
  );

describe("log level setting", () => {
  it("logs everything until someone picks a level", async () => {
    expect(await withRows({}).getLogLevel()).toBe("debug");
    expect(await withRows({ [SettingKeys.LogLevel]: "trace" }).getLogLevel()).toBe("debug");
  });

  it("reads a stored level", async () => {
    expect(await withRows({ [SettingKeys.LogLevel]: "warn" }).getLogLevel()).toBe("warn");
  });

  it("silences everything below the chosen level on the shared logger", () => {
    setLogLevel("warn");
    expect(appLogger.isLevelEnabled("log")).toBe(false);
    expect(appLogger.isLevelEnabled("warn")).toBe(true);
    expect(appLogger.isLevelEnabled("error")).toBe(true);
    setLogLevel("debug");
    expect(appLogger.isLevelEnabled("debug")).toBe(true);
  });
});
