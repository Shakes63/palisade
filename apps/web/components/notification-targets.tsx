"use client";
import { useEffect, useState } from "react";
import { Bell, Plus, Save, Send, Trash2 } from "lucide-react";
import {
  DEFAULT_NOTIFY_EVENTS,
  NOTIFY_EVENT_GROUPS,
  type EventType,
  type NotificationKind,
  type NotificationTarget,
} from "@ark/shared";
import { apiGet, apiPost, apiPut } from "@/lib/api";

const KIND_OPTIONS: { value: NotificationKind; label: string; placeholder: string }[] = [
  { value: "discord", label: "Discord", placeholder: "https://discord.com/api/webhooks/…" },
  { value: "slack", label: "Slack", placeholder: "https://hooks.slack.com/services/…" },
  { value: "ntfy", label: "ntfy", placeholder: "https://ntfy.sh/your-topic" },
  { value: "webhook", label: "Generic webhook (JSON)", placeholder: "https://example.com/hook" },
];

/** Settings card: multiple notification destinations, each with its own event subscription. */
export function NotificationTargetsCard() {
  const [targets, setTargets] = useState<NotificationTarget[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  useEffect(() => {
    apiGet<{ targets: NotificationTarget[] }>("/notifications")
      .then((r) => setTargets(r.targets))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const update = (id: string, patch: Partial<NotificationTarget>) => {
    setSaved(false);
    setTargets((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const add = () => {
    setSaved(false);
    setTargets((ts) => [
      ...ts,
      {
        id: `t-${Date.now().toString(36)}-${ts.length}`,
        name: "New destination",
        kind: "discord",
        url: "",
        enabled: true,
        events: [...DEFAULT_NOTIFY_EVENTS],
      },
    ]);
  };

  const save = async () => {
    setBusy(true);
    try {
      await apiPut("/notifications", { targets });
      setSaved(true);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Tests the SAVED config — nudge the user if they test with unsaved edits.
  const test = async (id: string) => {
    setTestMsg((m) => ({ ...m, [id]: "Sending…" }));
    try {
      const res = await apiPost<{ sent: boolean; error?: string }>(`/notifications/test/${id}`);
      setTestMsg((m) => ({
        ...m,
        [id]: res.sent ? "Test sent ✓" : `Failed: ${res.error ?? "unknown"} (saved config is what's tested)`,
      }));
    } catch (err) {
      setTestMsg((m) => ({ ...m, [id]: (err as Error).message }));
    }
  };

  const groupChecked = (t: NotificationTarget, types: EventType[]) =>
    types.every((ty) => t.events.includes(ty));

  const toggleGroup = (t: NotificationTarget, types: EventType[]) => {
    const on = groupChecked(t, types);
    const next = on ? t.events.filter((e) => !types.includes(e)) : [...new Set([...t.events, ...types])];
    update(t.id, { events: next });
  };

  return (
    <div className="card space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
        <Bell className="h-4 w-4" /> Notifications
      </h2>
      <p className="text-xs text-slate-500">
        Send server events to Discord, Slack, ntfy, or any webhook. Each destination picks its own
        events. Crashes, failed/empty backups, and low-disk warnings ride “Crashes, warnings &amp; errors”.
      </p>

      {loaded && targets.length === 0 && (
        <p className="text-sm text-slate-400">No destinations yet.</p>
      )}

      {targets.map((t) => {
        const kindMeta = KIND_OPTIONS.find((k) => k.value === t.kind) ?? KIND_OPTIONS[0]!;
        return (
          <div key={t.id} className="space-y-3 rounded-lg border border-slate-700/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input w-40"
                value={t.name}
                onChange={(e) => update(t.id, { name: e.target.value })}
                placeholder="Name"
              />
              <select
                className="input w-44"
                value={t.kind}
                onChange={(e) => update(t.id, { kind: e.target.value as NotificationKind })}
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <label className="ml-auto flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={t.enabled}
                  onChange={(e) => update(t.id, { enabled: e.target.checked })}
                />
                Enabled
              </label>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setSaved(false);
                  setTargets((ts) => ts.filter((x) => x.id !== t.id));
                }}
                title="Remove destination"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="flex gap-2">
              <input
                className="input"
                value={t.url}
                onChange={(e) => update(t.id, { url: e.target.value })}
                placeholder={kindMeta.placeholder}
              />
              <button type="button" className="btn-secondary shrink-0" onClick={() => test(t.id)}>
                <Send className="h-4 w-4" /> Test
              </button>
            </div>
            {testMsg[t.id] && <p className="text-xs text-slate-400">{testMsg[t.id]}</p>}
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {NOTIFY_EVENT_GROUPS.map((g) => (
                <label key={g.key} className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={groupChecked(t, g.types)}
                    onChange={() => toggleGroup(t, g.types)}
                  />
                  {g.label}
                </label>
              ))}
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" onClick={add}>
          <Plus className="h-4 w-4" /> Add destination
        </button>
        <button type="button" className="btn-primary" onClick={save} disabled={busy || !loaded}>
          <Save className="h-4 w-4" /> {busy ? "Saving…" : saved ? "Saved ✓" : "Save notifications"}
        </button>
      </div>
    </div>
  );
}
