"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, Trash2, Package, Loader2, Info } from "lucide-react";
import { apiGet, apiDelete, apiUpload } from "@/lib/api";

type BedrockPack = { uuid: string; name: string; type: "behavior" | "resource" };
type BedrockModStatus = { packs: BedrockPack[] };

/**
 * Bedrock add-on manager. Upload a .mcpack (one pack) or .mcaddon (a bundle); the
 * server unzips it, reads each manifest, copies packs into behavior_packs/
 * resource_packs, and activates them in the world so they're live on next restart.
 */
export function BedrockModsTab({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<BedrockModStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    apiGet<BedrockModStatus>(`/servers/${serverId}/bedrockmods`)
      .then(setStatus)
      .catch((e) => setErr(e.message));
  }, [serverId]);
  useEffect(() => load(), [load]);

  const run = async (fn: () => Promise<BedrockModStatus>) => {
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

  const packs = status?.packs ?? [];

  return (
    <div className="space-y-4">
      {err && <div className="card border-rose-500/40 text-sm text-rose-300">{err}</div>}

      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            <Package className="h-4 w-4" /> Add-on packs
          </h3>
          <button className="btn-secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload
            add-on
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".mcpack,.mcaddon,.zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) run(() => apiUpload(`/servers/${serverId}/bedrockmods/packs`, f));
              e.target.value = "";
            }}
          />
        </div>

        {packs.length > 0 ? (
          <ul className="divide-y divide-ark-border/50 text-sm">
            {packs.map((p) => (
              <li key={p.uuid} className="flex items-center justify-between gap-3 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      p.type === "behavior"
                        ? "bg-ark-accent/20 text-ark-accent"
                        : "bg-ark-accent2/20 text-ark-accent2"
                    }`}
                  >
                    {p.type}
                  </span>
                  <span className="truncate text-slate-200">{p.name}</span>
                </div>
                <button
                  className="shrink-0 text-slate-500 hover:text-rose-400"
                  title="Remove"
                  disabled={busy}
                  onClick={() =>
                    run(() => apiDelete(`/servers/${serverId}/bedrockmods/packs/${encodeURIComponent(p.uuid)}`))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">
            No add-ons yet. Upload a <span className="font-mono">.mcpack</span> (one pack) or{" "}
            <span className="font-mono">.mcaddon</span> (a bundle) — behavior + resource packs are installed and
            activated in the world automatically.
          </p>
        )}
        <p className="text-[11px] text-slate-500">Restart the server to load add-on changes.</p>
      </div>

      <div className="card space-y-2 border-ark-border">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-300">
          <Info className="h-4 w-4" /> Good to know
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-xs leading-snug text-slate-400">
          <li>
            <span className="text-slate-200">Behavior packs</span> are server-side (mobs, items, rules).{" "}
            <span className="text-slate-200">Resource packs</span> change visuals and are sent to each player
            on join.
          </li>
          <li>
            To force a resource pack on everyone, turn on{" "}
            <span className="font-mono">Require server texture pack</span> under{" "}
            <span className="font-mono">Settings → World</span>.
          </li>
          <li>Some add-ons need a specific game version — make sure the server&apos;s version matches.</li>
        </ul>
      </div>
    </div>
  );
}
