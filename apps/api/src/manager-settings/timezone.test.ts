import { describe, it, expect } from "vitest";
import { ManagerSettingsController } from "./manager-settings.controller";
import { DEFAULT_TIMEZONE, ManagerSettingsService, SettingKeys } from "./manager-settings.service";

const withRows = (rows: Record<string, string>) =>
  new ManagerSettingsController(
    new ManagerSettingsService(
      {
        managerSetting: {
          findUnique: async ({ where }: { where: { key: string } }) =>
            where.key in rows ? { key: where.key, value: rows[where.key], isSecret: false } : null,
        },
      } as never,
      { decrypt: (v: string) => v } as never,
    ),
    {} as never,
  );

describe("GET settings/timezone", () => {
  it("reports the default until someone picks a zone", async () => {
    expect(await withRows({}).timezone()).toEqual({ timezone: DEFAULT_TIMEZONE });
  });

  it("reports the stored zone", async () => {
    expect(await withRows({ [SettingKeys.Timezone]: "Europe/Berlin" }).timezone()).toEqual({
      timezone: "Europe/Berlin",
    });
  });
});
