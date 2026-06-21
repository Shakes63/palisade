// Friendly schedule ↔ cron helpers, so the UI never makes users write cron.

export type Frequency = "daily" | "weekly" | "hourly" | "everyN" | "once";

/** Cron representation of a one-time datetime, stored only for display — the
 *  backend fires one-shots by their absolute runAt, not this. `local` is a
 *  datetime-local value ("YYYY-MM-DDTHH:MM"). */
export function onceCron(local: string): string {
  const d = new Date(local);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

/** Compact local date+time for display, e.g. "Jun 25, 2:00 AM". */
export function fmtLocal(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export interface CronParts {
  frequency: Frequency;
  time: string; // "HH:MM" (daily/weekly)
  days: number[]; // 0=Sun … 6=Sat (weekly)
  intervalHours: number; // everyN
  minute: number; // hourly/everyN — minute past the hour
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Friendly parts → a standard 5-field cron string. */
export function buildCron(p: CronParts): string {
  if (p.frequency === "hourly") return `${p.minute} * * * *`;
  if (p.frequency === "everyN") return `${p.minute} */${p.intervalHours} * * *`;
  const [h, m] = p.time.split(":").map(Number);
  if (p.frequency === "weekly") {
    const days = (p.days.length ? [...p.days] : [0]).sort((a, b) => a - b).join(",");
    return `${m} ${h} * * ${days}`;
  }
  return `${m} ${h} * * *`; // daily
}

function fmtTime(h: number, m: number): string {
  const ap = h < 12 ? "AM" : "PM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ap}`;
}

/** Human-readable description of a cron string (covers what buildCron emits;
 *  falls back to the raw cron for anything hand-written/unusual). */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, mon, dow] = parts;
  const mi = Number(m);
  if (dom === "*" && mon === "*") {
    if (dow === "*") {
      if (h === "*") return `Every hour at :${String(mi).padStart(2, "0")}`;
      if (h.startsWith("*/")) return `Every ${h.slice(2)} hours`;
      if (/^\d+$/.test(h)) return `Every day at ${fmtTime(Number(h), mi)}`;
    } else if (/^\d+$/.test(h)) {
      const all = dow.split(",").every((_, i, a) => a.length === 7);
      if (all) return `Every day at ${fmtTime(Number(h), mi)}`;
      const days = dow
        .split(",")
        .map((d) => DOW[Number(d) % 7] ?? d)
        .join(", ");
      return `${days} at ${fmtTime(Number(h), mi)}`;
    }
  }
  return cron;
}
