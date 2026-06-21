"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { buildCron, describeCron, type Frequency } from "@/lib/cron";

interface Schedule {
  id: string;
  name: string;
  cron: string;
  action: string;
  warnMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
}

const ACTIONS: { value: string; label: string; hint: string }[] = [
  { value: "restart", label: "Restart", hint: "Stop and start (clears memory creep)." },
  { value: "backup", label: "Backup", hint: "Take a world snapshot." },
  { value: "update", label: "Update", hint: "Update game files, then restart." },
  { value: "stop", label: "Stop", hint: "Shut the server down." },
  { value: "start", label: "Start", hint: "Bring the server up." },
];
const FREQS: { value: Frequency; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Certain days" },
  { value: "hourly", label: "Every hour" },
  { value: "everyN", label: "Every few hours" },
];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DISRUPTIVE = new Set(["restart", "update", "stop"]);
const actionLabel = (a: string) => ACTIONS.find((x) => x.value === a)?.label ?? a;

export function ScheduleList({ serverId }: { serverId: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [action, setAction] = useState("restart");
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [time, setTime] = useState("05:00");
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [intervalHours, setIntervalHours] = useState(6);
  const [minute, setMinute] = useState(0);
  const [warnMinutes, setWarnMinutes] = useState(10);
  const [name, setName] = useState("");

  const refresh = useCallback(() => {
    apiGet<Schedule[]>(`/schedules?serverId=${serverId}`).then(setSchedules).catch(() => undefined);
  }, [serverId]);
  useEffect(() => refresh(), [refresh]);

  const cron = useMemo(
    () => buildCron({ frequency, time, days, intervalHours, minute }),
    [frequency, time, days, intervalHours, minute],
  );
  const disruptive = DISRUPTIVE.has(action);
  const summary = `${actionLabel(action)} · ${describeCron(cron)}`;

  const toggleDay = (d: number) =>
    setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (frequency === "weekly" && days.length === 0) return alert("Pick at least one day.");
    try {
      await apiPost("/schedules", {
        serverId,
        name: name.trim() || summary,
        cron,
        action,
        warnMinutes: disruptive ? Number(warnMinutes) : 0,
        enabled: true,
      });
      setName("");
      refresh();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const toggleEnabled = async (s: Schedule) => {
    await apiPatch(`/schedules/${s.id}`, { enabled: !s.enabled }).catch(() => undefined);
    refresh();
  };
  const remove = async (id: string) => {
    await apiDelete(`/schedules/${id}`).catch(() => undefined);
    refresh();
  };

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="card space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Do this</label>
            <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">{ACTIONS.find((a) => a.value === action)?.hint}</p>
          </div>
          <div>
            <label className="label">How often</label>
            <select
              className="input"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as Frequency)}
            >
              {FREQS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* When-controls per frequency */}
        <div className="flex flex-wrap items-end gap-4">
          {frequency === "weekly" && (
            <div>
              <label className="label">On days</label>
              <div className="flex gap-1">
                {DAYS.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(i)}
                    className={`h-8 w-9 rounded-md text-xs font-medium ${
                      days.includes(i)
                        ? "bg-ark-accent text-slate-900"
                        : "bg-slate-700/50 text-slate-400 hover:bg-slate-700"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(frequency === "daily" || frequency === "weekly") && (
            <div>
              <label className="label">At</label>
              <input
                type="time"
                className="input w-auto"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          )}
          {frequency === "everyN" && (
            <div>
              <label className="label">Every</label>
              <select
                className="input w-auto"
                value={intervalHours}
                onChange={(e) => setIntervalHours(Number(e.target.value))}
              >
                {[2, 3, 4, 6, 8, 12].map((n) => (
                  <option key={n} value={n}>
                    {n} hours
                  </option>
                ))}
              </select>
            </div>
          )}
          {(frequency === "hourly" || frequency === "everyN") && (
            <div>
              <label className="label">At minute</label>
              <input
                type="number"
                min={0}
                max={59}
                className="input w-20"
                value={minute}
                onChange={(e) => setMinute(Math.min(59, Math.max(0, Number(e.target.value))))}
              />
            </div>
          )}
        </div>

        {disruptive && (
          <div className="max-w-xs">
            <label className="label">Warn players (minutes)</label>
            <input
              type="number"
              min={0}
              max={60}
              className="input w-24"
              value={warnMinutes}
              onChange={(e) => setWarnMinutes(Math.max(0, Number(e.target.value)))}
            />
            <p className="mt-1 text-xs text-slate-500">
              In-game countdown chat to players before it runs (one message per minute). A backup is
              also taken first. 0 = no warning.
            </p>
          </div>
        )}

        <div>
          <label className="label">Name (optional)</label>
          <input
            className="input"
            placeholder={summary}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ark-border/50 pt-3">
          <p className="text-sm text-slate-300">
            <CalendarClock className="mr-1 inline h-4 w-4 text-ark-accent2" />
            {summary}
          </p>
          <button className="btn-primary">
            <Plus className="h-4 w-4" /> Add schedule
          </button>
        </div>
      </form>

      {schedules.length === 0 ? (
        <div className="card text-slate-400">
          No schedules yet. Disruptive actions warn players and take a backup first.
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className="card flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <CalendarClock className="h-5 w-5 shrink-0 text-ark-accent2" />
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-slate-400">
                    {actionLabel(s.action)} · {describeCron(s.cron)}
                    {s.warnMinutes ? ` · warn ${s.warnMinutes}m` : ""}
                    {s.lastRunAt ? ` · last ${new Date(s.lastRunAt).toLocaleString()}` : ""}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleEnabled(s)}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    s.enabled
                      ? "bg-green-500/15 text-green-400"
                      : "bg-slate-500/15 text-slate-400"
                  }`}
                >
                  {s.enabled ? "On" : "Off"}
                </button>
                <button className="btn-danger" onClick={() => remove(s.id)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
