import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  DEFAULT_NOTIFY_EVENTS,
  EventType,
  type NotificationTarget,
} from "@ark/shared";
import { EventsService, type EmitEventInput } from "../events/events.service";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";

/** The legacy single-webhook subscribed to this fixed set — preserved on migration. */
const LEGACY_TYPES: EventType[] = [
  EventType.StateTransition,
  EventType.InstallFinished,
  EventType.UpdateAvailable,
  EventType.BackupCreated,
  EventType.ScheduleFired,
  EventType.Warning,
  EventType.Error,
];

/**
 * Dispatches events to the configured notification targets (Discord, Slack,
 * ntfy, generic webhook), each with its own event subscription. Subscribes to
 * the in-process event bus so it never couples into emit paths.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly events: EventsService,
    private readonly settings: ManagerSettingsService,
  ) {}

  onModuleInit(): void {
    this.events.onEvent((input) => void this.handle(input));
  }

  async getTargets(): Promise<NotificationTarget[]> {
    const raw = await this.settings.get(SettingKeys.NotificationTargets);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as NotificationTarget[];
        if (Array.isArray(parsed)) return parsed;
      } catch {
        this.logger.warn("notification_targets setting is not valid JSON — ignoring");
      }
      return [];
    }
    // One-time migration: carry a legacy single Discord webhook over as a target.
    const legacy = await this.settings.get(SettingKeys.DiscordWebhook);
    if (!legacy) return [];
    const migrated: NotificationTarget[] = [
      { id: "legacy-discord", name: "Discord", kind: "discord", url: legacy, enabled: true, events: LEGACY_TYPES },
    ];
    await this.saveTargets(migrated);
    return migrated;
  }

  async saveTargets(targets: NotificationTarget[]): Promise<void> {
    await this.settings.set(SettingKeys.NotificationTargets, JSON.stringify(targets));
  }

  private async handle(input: EmitEventInput): Promise<void> {
    const targets = await this.getTargets().catch(() => [] as NotificationTarget[]);
    const matching = targets.filter((t) => t.enabled && t.url && t.events.includes(input.type));
    await Promise.all(
      matching.map((t) =>
        this.deliver(t, input.type, input.message).catch((err) =>
          this.logger.warn(`notify "${t.name}" (${t.kind}) failed: ${(err as Error).message}`),
        ),
      ),
    );
  }

  /** Format + POST one message for a target's kind. */
  private async deliver(target: NotificationTarget, type: EventType, message: string): Promise<void> {
    const urgent = type === EventType.Warning || type === EventType.Error;
    if (target.kind === "ntfy") {
      // ntfy takes the plain-text body; metadata rides headers.
      await this.post(target.url, message, {
        "Content-Type": "text/plain",
        Title: `Palisade — ${type}`,
        Priority: urgent ? "high" : "default",
        Tags: urgent ? "warning" : "video_game",
      });
      return;
    }
    const body =
      target.kind === "discord"
        ? { content: `**[${type}]** ${message}` }
        : target.kind === "slack"
          ? { text: `[${type}] ${message}` }
          : { source: "palisade", type, message, at: new Date().toISOString() };
    await this.post(target.url, JSON.stringify(body), { "Content-Type": "application/json" });
  }

  private async post(url: string, body: string, headers: Record<string, string>): Promise<void> {
    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok && res.status !== 204) {
      throw new Error(`endpoint responded ${res.status}`);
    }
  }

  /** Send a test message through one configured target. */
  async test(targetId: string): Promise<{ sent: boolean; error?: string }> {
    const target = (await this.getTargets()).find((t) => t.id === targetId);
    if (!target || !target.url) return { sent: false, error: "Target not found or has no URL" };
    try {
      await this.deliver(target, EventType.Warning, "Palisade test notification ✅");
      return { sent: true };
    } catch (err) {
      return { sent: false, error: (err as Error).message };
    }
  }
}
