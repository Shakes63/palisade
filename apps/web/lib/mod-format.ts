/** Human-readable byte size (e.g. 1536 → "1.5 KB"). */
export function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)} ${units[i]}`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** Compact download count (e.g. 10540000 → "10.5M", 10540 → "10.5K"). */
export function fmtCount(n: number): string {
  return compact.format(n);
}

/** Short absolute date (e.g. "Jun 18, 2026") from an ISO string. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
