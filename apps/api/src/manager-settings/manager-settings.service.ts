import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";

/** Well-known manager setting keys. */
export const SettingKeys = {
  DataDir: "data_dir",
  Timezone: "timezone",
  CurseForgeApiKey: "curseforge_api_key", // secret
  SteamWebApiKey: "steam_web_api_key", // secret
  DiscordWebhook: "discord_webhook_url",
  Initialized: "initialized",
} as const;

const SECRET_KEYS = new Set<string>([SettingKeys.CurseForgeApiKey, SettingKeys.SteamWebApiKey]);

/** Fallback timezone when the user hasn't picked one yet (matches the web default). */
export const DEFAULT_TIMEZONE = "America/Chicago";

/**
 * Manager-level key/value settings (paths, timezone, API keys). Secret values are
 * transparently encrypted/decrypted via CryptoService.
 */
@Injectable()
export class ManagerSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async get(key: string): Promise<string | null> {
    const row = await this.prisma.managerSetting.findUnique({ where: { key } });
    if (!row) return null;
    return row.isSecret ? this.crypto.decrypt(row.value) : row.value;
  }

  /** The configured IANA timezone (the in-app picker) — the single source of
   *  truth for scheduled-task timing and game-container clocks. */
  async getTimezone(): Promise<string> {
    return (await this.get(SettingKeys.Timezone)) || DEFAULT_TIMEZONE;
  }

  async set(key: string, value: string): Promise<void> {
    const isSecret = SECRET_KEYS.has(key);
    const stored = isSecret ? this.crypto.encrypt(value) : value;
    await this.prisma.managerSetting.upsert({
      where: { key },
      create: { key, value: stored, isSecret },
      update: { value: stored, isSecret },
    });
  }

  async isInitialized(): Promise<boolean> {
    return (await this.get(SettingKeys.Initialized)) === "true";
  }

  async markInitialized(): Promise<void> {
    await this.set(SettingKeys.Initialized, "true");
  }

  /** Non-secret settings only, for the UI. Secret presence is reported as a boolean. */
  async publicView(): Promise<Record<string, string | boolean>> {
    const rows = await this.prisma.managerSetting.findMany();
    const out: Record<string, string | boolean> = {};
    for (const r of rows) {
      out[r.key] = r.isSecret ? true : r.value;
    }
    return out;
  }
}
