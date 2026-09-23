"use client";
import { useEffect, useRef, useState } from "react";
import { Upload, Trash2, Package, Loader2, TriangleAlert } from "lucide-react";
import { apiGet, apiDelete, apiUpload } from "@/lib/api";
import { confirmDialog } from "@/components/dialogs";

type SdtdModStatus = { mods: string[] };

/**
 * 7 Days to Die mods aren't on a central browser — they're community folders (from
 * the official forums / NexusMods) dropped into the server's Mods/ directory. Upload
 * a mod .zip here; it unpacks into serverfiles/Mods and loads on the next restart.
 * Two 7DTD quirks are called out: every player usually needs the same mods, and mods
 * that ship code (DLLs) need EAC (Easy Anti-Cheat) off, which Palisade doesn't expose.
 */
export function SevenDaysModsTab({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<SdtdModStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiGet<SdtdModStatus>(`/servers/${serverId}/sevendaysmods`)
      .then(setStatus)
      .catch((e) => setErr(e.message));
  }, [serverId]);

  const run = async (fn: () => Promise<SdtdModStatus>) => {
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            <Package className="h-4 w-4" /> Installed mods
          </h3>
          <button className="btn-secondary shrink-0 whitespace-nowrap" disabled={busy} onClick={() => zipInput.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload .zip
          </button>
          <input
            ref={zipInput}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) run(() => apiUpload(`/servers/${serverId}/sevendaysmods/mods`, f));
              e.target.value = "";
            }}
          />
        </div>

        {status && status.mods.length > 0 ? (
          <ul className="divide-y divide-ark-border/50 text-sm">
            {status.mods.map((m) => (
              <li key={m} className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate font-mono text-slate-200">{m}</span>
                <button
                  className="shrink-0 text-slate-500 hover:text-rose-400"
                  title="Remove"
                  aria-label={`Remove ${m}`}
                  disabled={busy}
                  onClick={async () => {
                    if (!(await confirmDialog({ title: `Remove ${m} from this server?`, confirmLabel: "Remove", danger: true })))
                      return;
                    void run(() => apiDelete(`/servers/${serverId}/sevendaysmods/mods/${encodeURIComponent(m)}`));
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">
            No mods yet. Upload a <span className="font-mono">.zip</span> containing the mod folder (with its{" "}
            <span className="font-mono">ModInfo.xml</span>) — it unpacks into{" "}
            <span className="font-mono">Mods/</span>.
          </p>
        )}
        <p className="text-[11px] text-slate-500">Restart the server to load mod changes.</p>
      </div>

      <div className="card space-y-2 border-amber-500/30">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-300">
          <TriangleAlert className="h-4 w-4" /> Two 7 Days to Die mod rules
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-xs leading-snug text-slate-400">
          <li>
            <span className="text-slate-200">Server-side vs. client-side.</span> Many mods (custom blocks,
            recipes, POIs) must also be installed by every connecting player, or they&apos;ll be disconnected.
            Pure server-side mods don&apos;t need the client.
          </li>
          <li>
            <span className="text-slate-200">XML mods only.</span> Mods made of XML and assets (modlets) run with
            Easy Anti-Cheat on. Mods that ship a <span className="font-mono">.dll</span> need EAC off, which
            Palisade can&apos;t turn off yet, so they won&apos;t load.
          </li>
        </ul>
        <p className="text-[11px] text-slate-500">
          Mods come from the official 7 Days to Die forums / NexusMods (there&apos;s no in-game workshop to browse).
        </p>
      </div>
    </div>
  );
}
