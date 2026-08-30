"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, ChevronDown, ArrowDownToLine, ArrowUpFromLine, ArrowLeft } from "lucide-react";
import { mapLabel, type ServerSummary } from "@ark/shared";
import { apiGet, apiPost } from "@/lib/api";

/**
 * Copy a server's settings and/or mods to/from other servers of the same game.
 * Reuses the existing GET /config + PATCH endpoints: "from" pulls a source into
 * this server (then the page reloads its config), "to" pushes this server's
 * config/mods onto the chosen targets. Same-game only — the catalogs differ.
 */
export function CopyMenu({
  server,
  onAfterCopyIn,
}: {
  server: ServerSummary;
  onAfterCopyIn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"from" | "to" | null>(null);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [settings, setSettings] = useState(true);
  const [mods, setMods] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const reset = () => {
    setOpen(false);
    setMode(null);
    setSel(new Set());
  };

  useEffect(() => {
    if (!open) return;
    apiGet<ServerSummary[]>("/servers").then(setServers).catch(() => undefined);
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) reset();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Same game, excluding this server.
  const others = servers.filter((s) => s.game === server.game && s.id !== server.id);

  const pick = (id: string) =>
    setSel((s) => {
      const n = new Set(mode === "from" ? [] : s); // "from" is single-select
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const what = [settings && "settings", mods && "mods"].filter(Boolean).join(" + ");

  // POST /servers/:source/copy replaces (not merges) the targets' settings/mods.
  const run = async () => {
    if (!settings && !mods) return alert("Choose settings, mods, or both.");
    if (sel.size === 0) return;
    setBusy(true);
    try {
      if (mode === "from") {
        const src = others.find((s) => s.id === [...sel][0]);
        if (!src) return;
        if (
          !confirm(
            `Replace THIS server's ${what} with “${src.name}”'s? Any unsaved edits in the settings editor will be lost.`,
          )
        )
          return;
        await apiPost(`/servers/${src.id}/copy`, { targetIds: [server.id], settings, mods });
        reset();
        onAfterCopyIn();
      } else {
        const targets = [...sel];
        if (
          !confirm(
            `Overwrite ${targets.length} server(s) with this server's ${what}? Their current ${what} will be replaced.`,
          )
        )
          return;
        const { copied } = await apiPost<{ copied: number }>(`/servers/${server.id}/copy`, {
          targetIds: targets,
          settings,
          mods,
        });
        alert(`Copied ${what} to ${copied} server(s).`);
        reset();
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn-secondary" onClick={() => (open ? reset() : setOpen(true))}>
        <Copy className="h-4 w-4" /> Copy
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-80 rounded-md border border-ark-border bg-ark-panel p-3 shadow-xl">
          {!mode ? (
            <div className="space-y-1">
              <button
                type="button"
                className="flex w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-ark-border"
                onClick={() => setMode("from")}
              >
                <ArrowDownToLine className="mt-0.5 h-4 w-4 shrink-0 text-ark-accent" />
                <span>
                  <span className="block text-sm font-medium text-slate-200">Copy from a server</span>
                  <span className="block text-[11px] text-slate-400">Pull another server&apos;s setup into this one</span>
                </span>
              </button>
              <button
                type="button"
                className="flex w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-ark-border"
                onClick={() => setMode("to")}
              >
                <ArrowUpFromLine className="mt-0.5 h-4 w-4 shrink-0 text-ark-accent" />
                <span>
                  <span className="block text-sm font-medium text-slate-200">Copy to servers…</span>
                  <span className="block text-[11px] text-slate-400">Push this server&apos;s setup to others</span>
                </span>
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
                onClick={() => {
                  setMode(null);
                  setSel(new Set());
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {mode === "from" ? "Copy from a server" : "Copy to servers"}
              </button>
              <div className="flex items-center gap-4 text-sm">
                <label className="flex items-center gap-1.5 text-slate-300">
                  <input type="checkbox" checked={settings} onChange={(e) => setSettings(e.target.checked)} /> Settings
                </label>
                <label className="flex items-center gap-1.5 text-slate-300">
                  <input type="checkbox" checked={mods} onChange={(e) => setMods(e.target.checked)} /> Mods
                </label>
              </div>
              <div className="max-h-56 space-y-0.5 overflow-auto">
                {others.length === 0 ? (
                  <p className="px-1 py-2 text-[12px] text-slate-500">
                    No other {server.game} servers to copy {mode === "from" ? "from" : "to"}.
                  </p>
                ) : (
                  others.map((s) => (
                    <label
                      key={s.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-ark-border"
                    >
                      <input
                        type={mode === "from" ? "radio" : "checkbox"}
                        name="copy-target"
                        checked={sel.has(s.id)}
                        onChange={() => pick(s.id)}
                      />
                      <span className="flex-1 truncate text-slate-200">{s.name}</span>
                      <span className="shrink-0 text-[10px] text-slate-500">{mapLabel(s.map)}</span>
                    </label>
                  ))
                )}
              </div>
              <button
                type="button"
                className="btn-primary w-full justify-center py-1.5 text-sm"
                disabled={busy || sel.size === 0 || (!settings && !mods)}
                onClick={run}
              >
                {busy
                  ? "Copying…"
                  : mode === "from"
                    ? "Copy into this server"
                    : `Copy to ${sel.size || ""} server(s)`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
