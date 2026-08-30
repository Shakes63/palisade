import { describe, it, expect } from "vitest";
import { ManagerSettingsService, SettingKeys } from "./manager-settings.service";

/**
 * These four settings shadow environment variables, so "not set here" has to stay
 * distinguishable from "set to false"/"set to empty" — otherwise opening the
 * Settings page once would silently override whatever the user's Docker template
 * says. Null means defer to the environment; everything else is a real answer.
 */
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

describe("boolean host overrides", () => {
  it("defers to the environment when the row is absent", async () => {
    expect(await withRows({}).getGameHostNetwork()).toBeNull();
    expect(await withRows({}).getAutoCreateNetwork()).toBeNull();
  });

  it("defers to the environment when the row is blank", async () => {
    // How the UI clears an override: the row stays, the value goes empty.
    expect(await withRows({ [SettingKeys.GameHostNetwork]: "" }).getGameHostNetwork()).toBeNull();
    expect(await withRows({ [SettingKeys.GameHostNetwork]: "   " }).getGameHostNetwork()).toBeNull();
  });

  it("reads a stored false as false, not as unset", async () => {
    // The whole point: this must beat a GAME_HOST_NETWORK=true template.
    expect(await withRows({ [SettingKeys.GameHostNetwork]: "false" }).getGameHostNetwork()).toBe(
      false,
    );
  });

  it("reads a stored true as true", async () => {
    expect(await withRows({ [SettingKeys.GameHostNetwork]: "true" }).getGameHostNetwork()).toBe(true);
  });

  it("accepts the 1/0 spelling the env vars also allow", async () => {
    expect(await withRows({ [SettingKeys.AutoCreateNetwork]: "1" }).getAutoCreateNetwork()).toBe(true);
    expect(await withRows({ [SettingKeys.AutoCreateNetwork]: "0" }).getAutoCreateNetwork()).toBe(false);
  });

  it("treats an unparseable value as unset rather than guessing", async () => {
    expect(await withRows({ [SettingKeys.GameHostNetwork]: "yes" }).getGameHostNetwork()).toBeNull();
  });
});

describe("string host overrides", () => {
  it("defers to the environment when absent or blank", async () => {
    expect(await withRows({}).getPublicBaseUrl()).toBeNull();
    expect(await withRows({ [SettingKeys.PublicBaseUrl]: "" }).getPublicBaseUrl()).toBeNull();
    expect(await withRows({ [SettingKeys.HostDataDir]: "  " }).getHostDataDir()).toBeNull();
  });

  it("returns a configured value, trimmed", async () => {
    expect(
      await withRows({ [SettingKeys.PublicBaseUrl]: " http://box:8970 " }).getPublicBaseUrl(),
    ).toBe("http://box:8970");
    expect(await withRows({ [SettingKeys.HostDataDir]: "/mnt/cache/appdata/x" }).getHostDataDir()).toBe(
      "/mnt/cache/appdata/x",
    );
  });
});
