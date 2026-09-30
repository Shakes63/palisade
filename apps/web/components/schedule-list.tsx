"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, Globe, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import {
  describePlayerCondition,
  GAME_LABELS,
  MAX_CONDITION_HELD_MINUTES,
  RCON_SCHEDULE_ACTIONS,
  type Game,
} from "@ark/shared";
import { buildCron, describeCron, onceCron, parseCron, fmtLocal, type Frequency } from "@/lib/cron";
import { confirmDialog, toast } from "@/components/dialogs";
import { ScheduleCopyMenu } from "@/components/schedule-copy-menu";
import { useMe } from "@/lib/use-me";

interface Schedule {
  id: string;
  name: string;
  cron: string;
  action: string;
  command: string | null;
  warnMinutes: number;
  enabled: boolean;
  minPlayersOnline: number | null;
  maxPlayersOnline: number | null;
  conditionHeldMinutes: number;
  lastRunAt: string | null;
  runAt: string | null;
  allServers?: boolean;
  serverIds?: string[];
  staggerMinutes?: number;
}

interface TargetServer {
  id: string;
  name: string;
  game: Game;
  actions: string[];
}

const ACTIONS: { value: string; label: string; hint: string }[] = [
  {
    value: "restart",
    label: "Restart",
    hint: "Warn players, take a backup, then stop and start. Some game images also install game updates on every start — the Guide tab says whether this one does.",
  },
  { value: "backup", label: "Backup", hint: "Take a world snapshot. No warning, no downtime." },
  {
    value: "update",
    label: "Update game",
    hint: "Warn players, take a backup, install the latest game build, then restart (a stopped server updates on its next start).",
  },
  {
    value: "update-if-available",
    label: "Update game if available",
    hint: "Check Steam for a newer build first. If there is one: warn players, take a backup, update, then restart. Otherwise nothing happens — no downtime.",
  },
  {
    value: "update-mods",
    label: "Update mods",
    hint: "Check for mod updates first (Valheim mods or a pinned Minecraft modpack). If there are any: warn players, take a backup, install them, then restart. Otherwise nothing happens.",
  },
  { value: "stop", label: "Stop", hint: "Warn players, take a backup, then shut the server down." },
  { value: "start", label: "Start", hint: "Bring the server up." },
  {
    value: "announce",
    label: "Announce",
    hint: "Send a chat message to everyone in-game. Runs only while the server is up.",
  },
  {
    value: "command",
    label: "Run a console command",
    hint: "Send a raw RCON command, exactly as you would type it in the Console tab. Runs only while the server is up.",
  },
];
const FREQS: { value: Frequency; label: string }[] = [
  { value: "once", label: "One time" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Certain days" },
  { value: "hourly", label: "Every hour" },
  { value: "everyN", label: "Every few hours" },
];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DISRUPTIVE = new Set(["restart", "update", "update-if-available", "update-mods", "stop"]);
const actionLabel = (a: string) => ACTIONS.find((x) => x.value === a)?.label ?? a;
/** A Date as a datetime-local value ("YYYY-MM-DDTHH:MM") in the browser's zone. */
const localInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
/** Short zone name right now, e.g. "CDT" (or "GMT+2" where there is no abbreviation). */
const zoneAbbr = (tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? tz;
const conditionSuffix = (s: Schedule) => {
  const text = describePlayerCondition(s.minPlayersOnline, s.maxPlayersOnline, s.conditionHeldMinutes);
  return text ? ` · only when ${text}` : "";
};
/** The player-count condition, as one picker rather than a comparison plus a
 *  threshold — "at most 0" is the old "skip while players are online" (GH #97). */
const CONDITIONS: { value: string; label: string }[] = [
  { value: "any", label: "Ignore it — always run" },
  { value: "atMost", label: "Run only when at most this many are online" },
  { value: "atLeast", label: "Run only when at least this many are online" },
];

/** One server's schedules, or with no serverId the global ones that run on many
 *  servers at once (GH #157). */
export function ScheduleList({ serverId }: { serverId?: string }) {
  const uid = useId();
  const me = useMe();
  const isGlobal = !serverId;
  const base = isGlobal ? "/global-schedules" : "/schedules";
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  // Per server: the global schedules that also run here, shown read-only.
  const [globals, setGlobals] = useState<Schedule[]>([]);
  const [targets, setTargets] = useState<TargetServer[]>([]);
  const [allServers, setAllServers] = useState(true);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [staggerMinutes, setStaggerMinutes] = useState(0);
  const [action, setAction] = useState("restart");
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [time, setTime] = useState("05:00");
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [intervalHours, setIntervalHours] = useState(6);
  const [minute, setMinute] = useState(0);
  const [command, setCommand] = useState("");
  const [warnMinutes, setWarnMinutes] = useState(10);
  const [condition, setCondition] = useState("any");
  const [threshold, setThreshold] = useState(0);
  const [held, setHeld] = useState(false);
  const [heldMinutes, setHeldMinutes] = useState(10);
  const [name, setName] = useState("");
  const [onceAt, setOnceAt] = useState("");
  const [editing, setEditing] = useState<Schedule | null>(null);
  // Recurring schedules fire in the scheduler zone from Settings, not the browser's (GH #87).
  const [timezone, setTimezone] = useState<string | null>(null);
  const [supported, setSupported] = useState<string[] | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const refresh = useCallback(() => {
    if (!serverId) {
      apiGet<Schedule[]>("/global-schedules").then(setSchedules).catch(() => undefined);
      return;
    }
    apiGet<Schedule[]>(`/schedules?serverId=${serverId}`).then(setSchedules).catch(() => undefined);
    apiGet<Schedule[]>(`/global-schedules?serverId=${serverId}`).then(setGlobals).catch(() => undefined);
  }, [serverId]);
  useEffect(() => refresh(), [refresh]);
  useEffect(() => {
    // Globally every action is offered; servers that can't run it are skipped.
    if (!serverId) {
      apiGet<TargetServer[]>("/global-schedules/servers").then(setTargets).catch(() => undefined);
      return;
    }
    apiGet<string[]>(`/schedules/actions?serverId=${serverId}`)
      .then(setSupported)
      .catch(() => undefined);
  }, [serverId]);
  useEffect(() => {
    apiGet<{ timezone: string }>("/settings/timezone")
      .then((r) => setTimezone(r.timezone))
      .catch(() => undefined);
  }, []);
  const abbr = timezone ? ` ${zoneAbbr(timezone)}` : "";
  // Only a clock time ("… at 5:00 AM") means anything in a zone; "Every 6 hours" doesn't.
  const describeInZone = (c: string) => {
    const text = describeCron(c);
    return /\d [AP]M$/.test(text) ? text + abbr : text;
  };
  const browserZone = timezone ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
  // Saved instants read in the same zone as the recurring times beside them.
  const fmtInZone = (iso: string) => fmtLocal(iso, timezone ?? undefined) + abbr;
  const details = (s: Schedule) =>
    `${actionLabel(s.action)}${s.command ? ` "${s.command}"` : ""} · ` +
    (s.runAt ? `Once on ${fmtInZone(s.runAt)}` : describeInZone(s.cron)) +
    (s.warnMinutes ? ` · warn ${s.warnMinutes}m` : "") +
    conditionSuffix(s);
  const isSupported = (a: string) => supported === null || supported.includes(a);
  // Countdown warnings go out as in-game chat, which needs the same console as Announce.
  const canWarn = isSupported("announce");
  const hintFor = (a: string) => {
    const hint = ACTIONS.find((x) => x.value === a)?.hint ?? "";
    return canWarn ? hint : hint.replace(/^Warn players, t/, "T").replace("warn players, ", "");
  };
  const actionOptions = ACTIONS.filter((a) => isSupported(a.value) || a.value === editing?.action);
  /** Names of the servers a global schedule reaches whose game can't run its action. */
  const skippedOn = (all: boolean, ids: string[], a: string) =>
    targets.filter((t) => (all || ids.includes(t.id)) && !t.actions.includes(a)).map((t) => t.name);
  const formSkipped = skippedOn(allServers, targetIds, action);
  const toggleTarget = (id: string) =>
    setTargetIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const isOnce = frequency === "once";
  const cron = useMemo(
    () => buildCron({ frequency, time, days, intervalHours, minute }),
    [frequency, time, days, intervalHours, minute],
  );
  const disruptive = DISRUPTIVE.has(action);
  const needsText = RCON_SCHEDULE_ACTIONS.has(action);
  const what = needsText && command.trim() ? `${actionLabel(action)} "${command.trim()}"` : actionLabel(action);
  const minPlayersOnline = condition === "atLeast" ? threshold : null;
  const maxPlayersOnline = condition === "atMost" ? threshold : null;
  const conditionHeldMinutes = condition !== "any" && held ? heldMinutes : 0;
  const conditionText = describePlayerCondition(minPlayersOnline, maxPlayersOnline, conditionHeldMinutes);
  const when = isOnce
    ? onceAt
      ? `once on ${fmtLocal(onceAt)}`
      : "once — pick a date & time"
    : describeInZone(cron);
  const summary = `${what} · ${when}${conditionText ? ` · only when ${conditionText}` : ""}`;
  // "now" in datetime-local format, for the picker's min.
  const nowLocal = localInput(new Date());

  const toggleDay = (d: number) =>
    setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]));

  const resetForm = () => {
    setEditing(null);
    setAction("restart");
    setFrequency("daily");
    setTime("05:00");
    setDays([0, 1, 2, 3, 4, 5, 6]);
    setIntervalHours(6);
    setMinute(0);
    setCommand("");
    setWarnMinutes(10);
    setCondition("any");
    setThreshold(0);
    setHeld(false);
    setHeldMinutes(10);
    setName("");
    setOnceAt("");
    setAllServers(true);
    setTargetIds([]);
    setStaggerMinutes(0);
  };

  /** Load a saved schedule into the form (GH #83). A hand-written cron the form
   *  can't express keeps the form's current timing. */
  const startEdit = (s: Schedule) => {
    setEditing(s);
    setAction(s.action);
    setCommand(s.command ?? "");
    setWarnMinutes(s.warnMinutes);
    setCondition(s.minPlayersOnline !== null ? "atLeast" : s.maxPlayersOnline !== null ? "atMost" : "any");
    setThreshold(s.minPlayersOnline ?? s.maxPlayersOnline ?? 0);
    setHeld(s.conditionHeldMinutes > 0);
    setHeldMinutes(s.conditionHeldMinutes || 10);
    setName(s.name);
    setAllServers(s.allServers ?? true);
    setTargetIds(s.serverIds ?? []);
    setStaggerMinutes(s.staggerMinutes ?? 0);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (s.runAt) {
      setFrequency("once");
      setOnceAt(localInput(new Date(s.runAt)));
      return;
    }
    const parts = parseCron(s.cron);
    if (!parts) return;
    setFrequency(parts.frequency);
    setTime(parts.time);
    setDays(parts.days);
    setIntervalHours(parts.intervalHours);
    setMinute(parts.minute);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let cronStr = cron;
    let runAt: string | undefined;
    if (isOnce) {
      if (!onceAt) return toast.error("Pick a date and time.");
      const when = new Date(onceAt);
      if (when.getTime() <= Date.now()) return toast.error("Pick a time in the future.");
      runAt = when.toISOString();
      cronStr = onceCron(onceAt);
    } else if (frequency === "weekly" && days.length === 0) {
      return toast.error("Pick at least one day.");
    }
    if (needsText && !command.trim()) {
      return toast.error(action === "announce" ? "Type a message to announce." : "Type a command to run.");
    }
    if (isGlobal && !allServers && targetIds.length === 0) return toast.error("Pick at least one server.");
    const body = {
      name: name.trim() || summary,
      cron: cronStr,
      action,
      ...(needsText ? { command: command.trim() } : {}),
      warnMinutes: disruptive && canWarn ? Number(warnMinutes) : 0,
      minPlayersOnline,
      maxPlayersOnline,
      conditionHeldMinutes,
      // Null so an edit from one-time to recurring clears the stored instant.
      runAt: runAt ?? null,
      ...(isGlobal ? { allServers, serverIds: targetIds, staggerMinutes } : {}),
    };
    try {
      if (editing) await apiPatch(`${base}/${editing.id}`, body);
      else await apiPost(base, { ...(isGlobal ? {} : { serverId }), enabled: true, ...body });
      resetForm();
      refresh();
    } catch (err) {
      toast.error(err);
    }
  };

  const toggleEnabled = async (s: Schedule) => {
    await apiPatch(`${base}/${s.id}`, { enabled: !s.enabled }).catch(toast.error);
    refresh();
  };
  const remove = async (s: Schedule) => {
    if (!(await confirmDialog({ title: `Delete the schedule "${s.name}"?`, confirmLabel: "Delete", danger: true }))) return;
    await apiDelete(`${base}/${s.id}`).catch(toast.error);
    if (editing?.id === s.id) resetForm();
    refresh();
  };

  return (
    <div className="space-y-4">
      <form ref={formRef} onSubmit={submit} className={`card scroll-mt-4 space-y-4 ${editing ? "border-ark-accent/60" : ""}`}>
        {editing && (
          <p className="flex items-center gap-2 text-sm font-medium text-ark-accent">
            <Pencil className="h-4 w-4 shrink-0" /> Editing &ldquo;{editing.name}&rdquo;
          </p>
        )}
        {isGlobal && (
          <div>
            <span id={`${uid}-targets`} className="label">
              Run on
            </span>
            <div role="radiogroup" aria-labelledby={`${uid}-targets`} className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-1.5 text-slate-300">
                <input type="radio" checked={allServers} onChange={() => setAllServers(true)} /> All servers,
                including ones added later
              </label>
              <label className="flex items-center gap-1.5 text-slate-300">
                <input type="radio" checked={!allServers} onChange={() => setAllServers(false)} /> Only these
                servers
              </label>
            </div>
            {!allServers && (
              <div className="mt-2 grid max-h-56 gap-0.5 overflow-auto sm:grid-cols-2">
                {targets.map((t) => (
                  <label
                    key={t.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-ark-border"
                  >
                    <input type="checkbox" checked={targetIds.includes(t.id)} onChange={() => toggleTarget(t.id)} />
                    <span className="flex-1 truncate text-slate-200">{t.name}</span>
                    <span className="shrink-0 text-[10px] text-slate-500">{GAME_LABELS[t.game]}</span>
                  </label>
                ))}
              </div>
            )}
            {formSkipped.length > 0 && (
              <p className="mt-1 text-xs text-amber-400">
                Skipped on {formSkipped.join(", ")}: the game can&apos;t run this action.
              </p>
            )}
            <div className="mt-3 max-w-xs">
              <label htmlFor={`${uid}-stagger`} className="label">Stagger (minutes between servers)</label>
              <input
                id={`${uid}-stagger`}
                type="number"
                min={0}
                className="input w-24"
                value={staggerMinutes}
                onChange={(e) => setStaggerMinutes(Math.max(0, Number(e.target.value)))}
              />
              <p className="mt-1 text-xs text-slate-500">
                {staggerMinutes > 0
                  ? `Servers go one at a time in name order, each ${staggerMinutes} minute${staggerMinutes === 1 ? "" : "s"} after the last started. Turning the schedule off stops the ones still waiting.`
                  : "0 = every server at the same moment."}
              </p>
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-action`} className="label">Do this</label>
            <select id={`${uid}-action`} className="input" value={action} onChange={(e) => setAction(e.target.value)}>
              {actionOptions.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                  {isSupported(a.value) ? "" : " (not available for this game)"}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">{hintFor(action)}</p>
          </div>
          <div>
            <label htmlFor={`${uid}-freq`} className="label">How often</label>
            <select
              id={`${uid}-freq`}
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

        {needsText && (
          <div>
            <label htmlFor={`${uid}-text`} className="label">
              {action === "announce" ? "Message" : "Command"}
            </label>
            <input
              id={`${uid}-text`}
              className="input"
              value={command}
              placeholder={
                action === "announce" ? "Server restarts in 15 minutes!" : "SaveWorld"
              }
              onChange={(e) => setCommand(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              {action === "announce"
                ? "Sent as in-game chat. The panel picks the right syntax for the game, so type the message on its own."
                : "Sent to the server's console verbatim. Anything the Console tab accepts works here."}
            </p>
          </div>
        )}

        {/* When-controls per frequency */}
        <div className="flex flex-wrap items-end gap-4">
          {isOnce && (
            <div>
              <label htmlFor={`${uid}-once`} className="label">On</label>
              <input
                id={`${uid}-once`}
                type="datetime-local"
                className="input w-auto"
                value={onceAt}
                min={nowLocal}
                onChange={(e) => setOnceAt(e.target.value)}
              />
            </div>
          )}
          {frequency === "weekly" && (
            <div>
              <span id={`${uid}-days`} className="label">
                On days
              </span>
              <div role="group" aria-labelledby={`${uid}-days`} className="flex gap-1">
                {DAYS.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(i)}
                    aria-pressed={days.includes(i)}
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
              <label htmlFor={`${uid}-at`} className="label">At</label>
              <input
                id={`${uid}-at`}
                type="time"
                className="input w-auto"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          )}
          {frequency === "everyN" && (
            <div>
              <label htmlFor={`${uid}-every`} className="label">Every</label>
              <select
                id={`${uid}-every`}
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
              <label htmlFor={`${uid}-minute`} className="label">At minute</label>
              <input
                id={`${uid}-minute`}
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
        {timezone && (
          <p className="text-xs text-slate-500">
            {isOnce
              ? `The date and time are in your browser's zone (${browserZone}).`
              : `Times are in ${timezone}${abbr}, the scheduler timezone from Settings → General.` +
                (browserZone !== timezone ? ` Your browser is in ${browserZone}.` : "")}
          </p>
        )}

        {disruptive && canWarn && (
          <div className="max-w-xs">
            <label htmlFor={`${uid}-warn`} className="label">Warn players (minutes)</label>
            <input
              id={`${uid}-warn`}
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
          <label htmlFor={`${uid}-players`} className="label">Player count</label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id={`${uid}-players`}
              className="input sm:w-auto"
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
            >
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {condition !== "any" && (
              <input
                type="number"
                min={0}
                className="input w-20"
                value={threshold}
                onChange={(e) => setThreshold(Math.max(0, Number(e.target.value)))}
              />
            )}
          </div>
          {condition !== "any" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-300">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={held} onChange={(e) => setHeld(e.target.checked)} />
                …and this has been true for
              </label>
              <input
                type="number"
                min={1}
                max={MAX_CONDITION_HELD_MINUTES}
                aria-label="Minutes the player count must have held"
                className="input w-20"
                value={heldMinutes}
                disabled={!held}
                onChange={(e) =>
                  setHeldMinutes(Math.min(MAX_CONDITION_HELD_MINUTES, Math.max(1, Number(e.target.value))))
                }
              />
              minutes
            </div>
          )}
          <p className="mt-1 text-xs text-slate-500">
            {condition === "any"
              ? "The player count is ignored — it runs every time."
              : held
                ? `Checked against the player count over the last ${heldMinutes} minutes, so the server must have been running that long — a server that has just started hasn't met it yet, and neither has one whose manager just restarted. A recurring schedule just tries again next time; a one-time schedule is consumed. Counts that can't be read are ignored, so a game that reports no players runs once it has been up long enough.`
                : "Checked against the live player count when the schedule fires. A recurring schedule just tries again next time; a one-time schedule is consumed. If the count can't be read, it runs anyway."}
          </p>
        </div>

        <div>
          <label htmlFor={`${uid}-name`} className="label">Name (optional)</label>
          <input
            id={`${uid}-name`}
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
          <div className="flex items-center gap-2">
            {editing && (
              <button type="button" className="btn-secondary" onClick={resetForm}>
                Cancel
              </button>
            )}
            <button className="btn-primary">
              {editing ? (
                <>
                  <Save className="h-4 w-4" /> Save changes
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" /> Add schedule
                </>
              )}
            </button>
          </div>
        </div>
      </form>

      {schedules.length === 0 ? (
        <div className="card text-sm text-slate-400">
          No schedules yet. Disruptive actions {canWarn ? "warn players and take" : "take"} a backup first.
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div
              key={s.id}
              className={`card flex flex-wrap items-center justify-between gap-3 ${editing?.id === s.id ? "border-ark-accent/60" : ""}`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <CalendarClock className="h-5 w-5 shrink-0 text-ark-accent2" />
                <div className="min-w-0">
                  <div className="break-words font-medium">{s.name}</div>
                  <div className="text-xs text-slate-400">
                    {details(s)}
                    {s.lastRunAt ? ` · last ran ${fmtInZone(s.lastRunAt)}` : ""}
                    {isGlobal &&
                      (s.allServers
                        ? " · on all servers"
                        : ` · on ${s.serverIds?.length ?? 0} server${s.serverIds?.length === 1 ? "" : "s"}`)}
                    {isGlobal && s.staggerMinutes ? `, ${s.staggerMinutes}m apart` : ""}
                  </div>
                  {isGlobal && skippedOn(!!s.allServers, s.serverIds ?? [], s.action).length > 0 && (
                    <div className="text-xs text-amber-400">
                      Skipped on {skippedOn(!!s.allServers, s.serverIds ?? [], s.action).join(", ")}: the game
                      can&apos;t run this action.
                    </div>
                  )}
                  {!isSupported(s.action) && (
                    <div className="text-xs text-amber-400">
                      This game can&apos;t run this action, so the schedule fails every time.
                    </div>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => toggleEnabled(s)}
                  title={s.enabled ? "On: click to pause this schedule" : "Off: click to turn this schedule on"}
                  aria-pressed={s.enabled}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    s.enabled
                      ? "bg-green-500/15 text-green-400"
                      : "bg-slate-500/15 text-slate-400"
                  }`}
                >
                  {s.enabled ? "On" : "Off"}
                </button>
                <button className="btn-secondary" title="Edit" aria-label="Edit schedule" onClick={() => startEdit(s)}>
                  <Pencil className="h-4 w-4" />
                </button>
                {serverId && <ScheduleCopyMenu scheduleId={s.id} serverId={serverId} />}
                <button className="btn-remove" title="Delete" aria-label="Delete schedule" onClick={() => remove(s)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {globals.length > 0 && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Globe className="h-4 w-4 text-ark-accent2" /> Global schedules on this server
            {!me?.restricted && (
              <Link href="/schedules" className="text-xs font-normal text-ark-accent hover:underline">
                Manage
              </Link>
            )}
          </h3>
          {globals.map((s) => (
            <div key={s.id} className="card flex items-center gap-3">
              <CalendarClock className="h-5 w-5 shrink-0 text-ark-accent2" />
              <div className="min-w-0">
                <div className="break-words font-medium">
                  {s.name}
                  {!s.enabled && <span className="ml-2 text-xs font-normal text-slate-500">(off)</span>}
                </div>
                <div className="text-xs text-slate-400">
                  {details(s)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
