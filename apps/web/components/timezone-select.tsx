"use client";
import { useMemo } from "react";

/** Default timezone when nothing is configured/detected. */
export const DEFAULT_TIMEZONE = "America/Chicago";

/** The browser's detected IANA timezone, falling back to the default. */
export function detectZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

// A short fallback for runtimes without Intl.supportedValuesOf (very old browsers).
const FALLBACK_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Dropdown of every IANA timezone, grouped by region with current UTC offsets. */
export function TimezoneSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { groups, labels, known } = useMemo(() => {
    let zones: string[] = [];
    try {
      const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
      if (sv) zones = sv("timeZone");
    } catch {
      /* fall through to fallback */
    }
    if (!zones.length) zones = FALLBACK_ZONES;
    if (!zones.includes("UTC")) zones = ["UTC", ...zones];

    const offset = (z: string): string => {
      try {
        return (
          new Intl.DateTimeFormat("en-US", { timeZone: z, timeZoneName: "shortOffset" })
            .formatToParts(new Date())
            .find((p) => p.type === "timeZoneName")?.value ?? ""
        );
      } catch {
        return "";
      }
    };

    const labels = new Map<string, string>();
    const byRegion = new Map<string, string[]>();
    for (const z of zones) {
      const city = z.includes("/") ? z.split("/").slice(1).join(" / ").replace(/_/g, " ") : z;
      const off = offset(z);
      labels.set(z, off ? `${city} (${off})` : city);
      const region = z.includes("/") ? z.split("/")[0] : "Other";
      (byRegion.get(region) ?? byRegion.set(region, []).get(region)!).push(z);
    }
    const groups = [...byRegion.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { groups, labels, known: new Set(zones) };
  }, []);

  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {/* Keep a saved value selectable even if the runtime doesn't list it. */}
      {value && !known.has(value) && <option value={value}>{value}</option>}
      {groups.map(([region, zones]) => (
        <optgroup key={region} label={region}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {labels.get(z)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
