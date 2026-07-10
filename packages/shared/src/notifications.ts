import { EventType } from "./events";

/** Where a notification target delivers to. */
export type NotificationKind = "discord" | "slack" | "ntfy" | "webhook";

/** One configured notification destination with its own event subscription. */
export interface NotificationTarget {
  id: string;
  name: string;
  kind: NotificationKind;
  /** Discord/Slack webhook URL, ntfy topic URL (https://ntfy.sh/my-topic), or a generic endpoint. */
  url: string;
  enabled: boolean;
  /** Event types this target receives. */
  events: EventType[];
}

/** UI-facing toggle groups — each maps to the underlying event types. */
export const NOTIFY_EVENT_GROUPS: { key: string; label: string; types: EventType[] }[] = [
  { key: "problems", label: "Crashes, warnings & errors", types: [EventType.Warning, EventType.Error] },
  { key: "state", label: "Server start / stop transitions", types: [EventType.StateTransition] },
  { key: "updates", label: "Game updates available", types: [EventType.UpdateAvailable] },
  { key: "installs", label: "Installs finished", types: [EventType.InstallFinished] },
  { key: "backups", label: "Backups created", types: [EventType.BackupCreated] },
  { key: "schedules", label: "Schedules fired", types: [EventType.ScheduleFired] },
  { key: "players", label: "Player joins / leaves", types: [EventType.PlayerJoin, EventType.PlayerLeave] },
];

/** Sensible starting subscription for a new target (problems + updates + backups). */
export const DEFAULT_NOTIFY_EVENTS: EventType[] = [
  EventType.Warning,
  EventType.Error,
  EventType.UpdateAvailable,
  EventType.BackupCreated,
];
