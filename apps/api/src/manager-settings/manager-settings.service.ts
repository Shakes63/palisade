import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";

/** Well-known manager setting keys. */
export const SettingKeys = {
  DataDir: "data_dir",
  Timezone: "timezone",
  CurseForgeApiKey: "curseforge_api_key", // secret
  SteamWebApiKey: "steam_web_api_key", // secret
  DiscordWebhook: "discord_webhook_url", // legacy single-webhook (migrated to NotificationTargets)
  NotificationTargets: "notification_targets", // secret (JSON; webhook URLs grant post access)
  BackupKeep: "backup_keep",
  AutoStopOnStart: "auto_stop_on_start",
  // pfSense REST API (jaredhendrickson13 package) for one-click port-forwards.
  PfsenseHost: "pfsense_host",
  PfsenseApiKey: "pfsense_api_key", // secret
  PfsenseTargetIp: "pfsense_target_ip", // the LAN IP the game servers bind on
  Initialized: "initialized",
} as const;

/** Default number of backups kept per server (newest N) when unset. */
export const DEFAULT_BACKUP_KEEP = 10;

const SECRET_KEYS = new Set<string>([
  SettingKeys.CurseForgeApiKey,
  SettingKeys.SteamWebApiKey,
  SettingKeys.PfsenseApiKey,
  SettingKeys.NotificationTargets,
]);

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

  /** How many backups to keep per server (newest N). Clamped to a sane floor. */
  async getBackupKeep(): Promise<number> {
    const n = parseInt((await this.get(SettingKeys.BackupKeep)) ?? "", 10);
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_BACKUP_KEEP;
  }

  /** Whether starting a server may offer to back up + stop a running one to free
   *  RAM (the start-guard "swap"). Defaults ON when unset. */
  async getAutoStopOnStart(): Promise<boolean> {
    return (await this.get(SettingKeys.AutoStopOnStart)) !== "false";
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
