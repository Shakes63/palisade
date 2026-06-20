"use client";
import { useState } from "react";
import { Check, X, Search, ChevronDown } from "lucide-react";

/**
 * In-game "Unofficial" browser filter guide. ARK hides player-hosted servers
 * behind several non-obvious filter toggles; this spells out exactly which to
 * flip so a self-hosted server shows up. The password row is config-dependent
 * (the join password is a write-only secret, so the frontend can't know it) —
 * hence the conditional note rather than a hard ON/OFF.
 */
export function UnofficialListHelp({
  serverName,
  mapName,
  defaultOpen = false,
  className = "",
}: {
  serverName: string;
  mapName: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={`rounded-md border border-ark-border ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs font-medium text-slate-400 hover:text-slate-200"
      >
        <span className="flex items-center gap-1.5">
          <Search className="h-3.5 w-3.5" /> Find it on the in-game Unofficial list
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="space-y-1.5 border-t border-ark-border px-2.5 py-2 text-xs">
          <p className="text-slate-400">
            In <span className="text-slate-200">Join ARK → Unofficial</span>, set these filters:
          </p>
          <FilterRow state="on" label="Show Player Servers" />
          <FilterRow state="off" label="PC-Only Online Multiplayer" hint="hides crossplay servers" />
          <FilterRow state="off" label="Show Password Protected Servers" hint="ON only if you set a join password" />
          <p className="pt-1 leading-snug text-slate-400">
            Then search the name <span className="font-mono text-slate-200">{serverName}</span>
            {mapName ? (
              <>
                {" "}
                · map <span className="text-slate-200">{mapName}</span> or “Any”.
              </>
            ) : (
              "."
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function FilterRow({ state, label, hint }: { state: "on" | "off"; label: string; hint?: string }) {
  const on = state === "on";
  return (
    <div className="flex items-start gap-1.5">
      {on ? (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ark-accent" />
      ) : (
        <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
      )}
      <span className="text-slate-200">
        {label}{" "}
        <span className={on ? "font-semibold text-ark-accent" : "font-semibold text-rose-400"}>
          {on ? "ON" : "OFF"}
        </span>
        {hint && <span className="text-slate-500"> — {hint}</span>}
      </span>
    </div>
  );
}
