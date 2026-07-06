"use client";
import { useEffect, useRef, useState } from "react";
import { Upload, Trash2, Package, Loader2, TriangleAlert } from "lucide-react";
import { apiGet, apiDelete, apiUpload } from "@/lib/api";

type IcarusModStatus = { paks: string[] };

/**
 * Icarus mods aren't on Steam Workshop — they're Unreal .pak files from the
 * community (NexusMods / Project Daedalus). Upload them here; they drop into the
 * server's Icarus/Content/Paks/mods and load on the next restart. Two Icarus quirks
 * are called out: every player needs the same mods, and multiple mods must be merged
 * into one ._P.pak first (with the Icarus Mod Manager) — the server can't merge them.
 */
export function IcarusModsTab({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<IcarusModStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pakInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiGet<IcarusModStatus>(`/servers/${serverId}/icarusmods`)
      .then(setStatus)
      .catch((e) => setErr(e.message));
  }, [serverId]);

  const run = async (fn: () => Promise<IcarusModStatus>) => {
    setBusy(true);
    setErr(null);
    try {
      setStatus(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {err && <div className="card border-rose-500/40 text-sm text-rose-300">{err}</div>}

      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            <Package className="h-4 w-4" /> Pak mods
          </h3>
          <button className="btn-secondary" disabled={busy} onClick={() => pakInput.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload .pak
          </button>
          <input
            ref={pakInput}
            type="file"
            accept=".pak,.ucas,.utoc,.zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) run(() => apiUpload(`/servers/${serverId}/icarusmods/paks`, f));
              e.target.value = "";
            }}
          />
        </div>

        {status && status.paks.length > 0 ? (
          <ul className="divide-y divide-ark-border/50 text-sm">
            {status.paks.map((p) => (
              <li key={p} className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate font-mono text-slate-200">{p}</span>
                <button
                  className="shrink-0 text-slate-500 hover:text-rose-400"
                  title="Remove"
                  disabled={busy}
                  onClick={() =>
                    run(() => apiDelete(`/servers/${serverId}/icarusmods/paks/${encodeURIComponent(p)}`))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">
            No pak mods yet. Upload <span className="font-mono">.pak</span> files (or a{" "}
            <span className="font-mono">.zip</span> of them) — they go into{" "}
            <span className="font-mono">Icarus/Content/Paks/mods</span>.
          </p>
        )}
        <p className="text-[11px] text-slate-500">Restart the server to load mod changes.</p>
      </div>

      <div className="card space-y-2 border-amber-500/30">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-300">
          <TriangleAlert className="h-4 w-4" /> Two Icarus mod rules
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-xs leading-snug text-slate-400">
          <li>
            <span className="text-slate-200">Everyone needs the same mods.</span> Each connecting player must
            install the identical <span className="font-mono">.pak</span> locally too, or they&apos;ll get
            errors / be disconnected.
          </li>
          <li>
            <span className="text-slate-200">Multiple mods must be merged first.</span> Icarus won&apos;t load
            several separate mods — merge them into a single{" "}
            <span className="font-mono">._P.pak</span> with the Icarus Mod Manager, then upload that one file.
          </li>
        </ul>
        <p className="text-[11px] text-slate-500">
          Mods come from NexusMods / Project Daedalus (Icarus has no in-game workshop to browse).
        </p>
      </div>
    </div>
  );
}
