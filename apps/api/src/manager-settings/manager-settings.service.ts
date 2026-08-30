import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { applyHostDataDirOverride } from "../config/ensure-host-data-dir";

/** Well-known manager setting keys. */
export const SettingKeys = {
  DataDir: "data_dir",
  Timezone: "timezone",
  CurseForgeApiKey: "curseforge_api_key", // secret
  SteamWebApiKey: "steam_web_api_key", // secret
  DiscordWebhook: "discord_webhook_url", // legacy single-webhook (migrated to NotificationTargets)
  NotificationTargets: "notification_targets", // secret (JSON; webhook URLs grant post access)
  BackupReplication: "backup_replication", // secret (JSON; holds SFTP credentials)
  BackupReplicationStatus: "backup_replication_status", // non-secret sync status JSON
  SteamGridDbApiKey: "steamgriddb_api_key", // secret
  ArtworkCache: "artwork_cache", // non-secret JSON: per-game SGDB art URLs
  // Palisade's OWN database backups (backups/_manager). Game-server retention is
  // per-server (Server.backupKeep) — the legacy "backup_keep" row is migrated onto
  // each server and no longer read.
  ManagerBackupKeep: "manager_backup_keep",
  AutoStopOnStart: "auto_stop_on_start",
  // Host/runtime knobs that used to be env-only. Each is an OVERRIDE: unset here
  // means the environment variable (and its default) still decides, so an install
  // behaves exactly as its Docker template says until someone changes it in the UI.
  GameHostNetwork: "game_host_network",
  AutoCreateNetwork: "auto_create_network",
  PublicBaseUrl: "public_base_url",
  HostDataDir: "host_data_dir",
  // pfSense REST API (jaredhendrickson13 package) for one-click port-forwards.
  PfsenseHost: "pfsense_host",
  PfsenseApiKey: "pfsense_api_key", // secret
  PfsenseTargetIp: "pfsense_target_ip", // the LAN IP the game servers bind on
  Initialized: "initialized",
} as const;

/** Default number of AUTOMATIC backups kept per game server (newest N) when the
 *  server doesn't set its own. Manual backups are exempt entirely (GH #34). */
export const DEFAULT_BACKUP_KEEP = 10;

/** Default number of Palisade database snapshots kept (newest N). Matches the
 *  count this was hardcoded to before it became configurable. */
export const DEFAULT_MANAGER_BACKUP_KEEP = 14;

const SECRET_KEYS = new Set<string>([
  SettingKeys.CurseForgeApiKey,
  SettingKeys.SteamWebApiKey,
  SettingKeys.PfsenseApiKey,
  SettingKeys.NotificationTargets,
  SettingKeys.BackupReplication,
  SettingKeys.SteamGridDbApiKey,
]);

/** Fallback timezone when the user hasn't picked one yet (matches the web default). */
export const DEFAULT_TIMEZONE = "America/Chicago";

/**
 * Manager-level key/value settings (paths, timezone, API keys). Secret values are
 * transparently encrypted/decrypted via CryptoService.
 */
@Injectable()
export class ManagerSettingsService implements OnModuleInit {
  private readonly logger = new Logger(ManagerSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Push stored host overrides into the process environment before anything reads
   * them. onModuleInit (not onApplicationBootstrap) because Nest finishes every
   * module's init before the first bootstrap hook runs, and the server reconcile
   * that runs in one of those hooks already resolves paths.
   */
  async onModuleInit(): Promise<void> {
    await this.applyHostOverrides().catch((e) =>
      // A fresh install has no settings table rows yet, and a broken read here must
      // not take the boot down — the env vars still decide.
      this.logger.debug(`host overrides not applied: ${(e as Error).message}`),
    );
  }

  /** Re-apply the stored HOST_DATA_DIR (or fall back to the auto-detected path).
   *  Called at boot and again whenever the setting is saved, so it takes effect
   *  without a restart. */
  async applyHostOverrides(): Promise<void> {
    applyHostDataDirOverride(await this.getHostDataDir());
  }

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

  /** How many of Palisade's own database snapshots to keep (newest N). Clamped to
   *  a sane floor. Game-server retention lives on each server. */
  async getManagerBackupKeep(): Promise<number> {
    const n = parseInt((await this.get(SettingKeys.ManagerBackupKeep)) ?? "", 10);
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MANAGER_BACKUP_KEEP;
  }

  /**
   * A stored boolean override, or null when it isn't set here.
   *
   * Null is the whole point: these settings shadow environment variables, and
   * "unset" has to stay distinguishable from "false" or the UI would silently
   * override a template that says otherwise.
   */
  private async getBoolOverride(key: string): Promise<boolean | null> {
    const raw = (await this.get(key))?.trim().toLowerCase();
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    return null;
  }

  /** A stored non-empty string override, or null to defer to the environment. */
  private async getStringOverride(key: string): Promise<string | null> {
    return (await this.get(key))?.trim() || null;
  }

  /** Run game containers on the host network. Null = defer to GAME_HOST_NETWORK.
   *  A server's own `hostNetwork` column outranks this. */
  getGameHostNetwork(): Promise<boolean | null> {
    return this.getBoolOverride(SettingKeys.GameHostNetwork);
  }

  /** Let Palisade manage its Docker network. Null = defer to AUTO_CREATE_NETWORK. */
  getAutoCreateNetwork(): Promise<boolean | null> {
    return this.getBoolOverride(SettingKeys.AutoCreateNetwork);
  }

  /** Base URL used for links and the WebUI buttons Palisade puts on the game
   *  containers it spawns. Null = defer to PUBLIC_BASE_URL. */
  getPublicBaseUrl(): Promise<string | null> {
    return this.getStringOverride(SettingKeys.PublicBaseUrl);
  }

  /** The app-data path as the HOST's Docker daemon sees it. Null = defer to
   *  HOST_DATA_DIR (or its boot-time auto-detection). */
  getHostDataDir(): Promise<string | null> {
    return this.getStringOverride(SettingKeys.HostDataDir);
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
