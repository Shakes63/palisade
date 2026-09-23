"use client";
import { useEffect, useRef, useState } from "react";
import { Upload, Trash2, Package, Loader2, TriangleAlert } from "lucide-react";
import { apiGet, apiDelete, apiUpload } from "@/lib/api";
import { confirmDialog } from "@/components/dialogs";

type DragonwildsMod = { name: string; parts: string[]; complete: boolean };
type Status = { mods: DragonwildsMod[] };

/**
 * Dragonwilds mods are Unreal IoStore content from Nexus Mods: a .pak plus a .utoc
 * and .ucas of the same name, all three dropped into Content/Paks/~mods. The Linux
 * server finds a lone .pak but never mounts it (verified live), so the list flags
 * any mod that is missing a part. UE4SS Lua mods cannot run on the server at all.
 */
export function DragonwildsModsTab({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiGet<Status>(`/servers/${serverId}/dragonwildsmods`)
      .then(setStatus)
      .catch((e) => setErr(e.message));
  }, [serverId]);

  const run = async (fn: () => Promise<Status>) => {
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

  const uploadAll = async (files: FileList) => {
    // One request per file; the last response carries the final listing.
    await run(async () => {
      let last: Status | null = null;
      for (const f of Array.from(files)) last = await apiUpload<Status>(`/servers/${serverId}/dragonwildsmods/files`, f);
      return last ?? (await apiGet<Status>(`/servers/${serverId}/dragonwildsmods`));
    });
  };

  const incomplete = status?.mods.filter((m) => !m.complete) ?? [];

  return (
    <div className="space-y-4">
      {err && <div className="card border-rose-500/40 text-sm text-rose-300">{err}</div>}

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            <Package className="h-4 w-4" /> Installed mods
          </h3>
          <button className="btn-secondary shrink-0 whitespace-nowrap" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload mod files
          </button>
          <input
            ref={input}
            type="file"
            multiple
            accept=".pak,.utoc,.ucas,.zip"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void uploadAll(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {status && status.mods.length > 0 ? (
          <ul className="divide-y divide-ark-border/50 text-sm">
            {status.mods.map((m) => (
              <li key={m.name} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-slate-200">{m.name}</span>
                  <span className={`text-[11px] ${m.complete ? "text-slate-500" : "text-amber-300"}`}>
                    {m.complete
                      ? ".pak + .utoc + .ucas"
                      : `has ${m.parts.map((p) => `.${p}`).join(" + ")} — missing ${["pak", "utoc", "ucas"]
                          .filter((p) => !m.parts.includes(p))
                          .map((p) => `.${p}`)
                          .join(" + ")}; the server will not load it`}
                  </span>
                </span>
                <button
                  className="btn-remove"
                  title="Remove all three files"
                  aria-label={`Remove ${m.name}`}
                  disabled={busy}
                  onClick={async () => {
                    if (!(await confirmDialog({ title: `Remove ${m.name} from this server?`, confirmLabel: "Remove", danger: true })))
                      return;
                    void run(() => apiDelete(`/servers/${serverId}/dragonwildsmods/${encodeURIComponent(m.name)}`));
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">
            No mods yet. Select a mod&apos;s <span className="font-mono">.pak</span>,{" "}
            <span className="font-mono">.utoc</span> and <span className="font-mono">.ucas</span> together (or a{" "}
            <span className="font-mono">.zip</span> of them) — they go into{" "}
            <span className="font-mono">RSDragonwilds/Content/Paks/~mods</span>.
          </p>
        )}
        <p className="text-[11px] text-slate-500">Mods are read at startup only — restart the server to load changes.</p>
      </div>

      {incomplete.length > 0 && (
        <div className="card space-y-1 border-amber-500/30">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-300">
            <TriangleAlert className="h-4 w-4" /> {incomplete.length === 1 ? "A mod is" : `${incomplete.length} mods are`} missing files
          </h3>
          <p className="text-xs leading-snug text-slate-400">
            A <span className="font-mono">.pak</span> on its own is found but never mounted. Upload the matching{" "}
            <span className="font-mono">.utoc</span> and <span className="font-mono">.ucas</span> from the same
            download, then restart.
          </p>
        </div>
      )}

      <div className="card space-y-2 border-amber-500/30">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-300">
          <TriangleAlert className="h-4 w-4" /> What works on a dedicated server
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-xs leading-snug text-slate-400">
          <li>
            <span className="text-slate-200">Pak mods only.</span> Look for mods whose instructions say{" "}
            <span className="font-mono">Content/Paks/~mods</span>. Anything mentioning UE4SS,{" "}
            <span className="font-mono">Mods.txt</span> or <span className="font-mono">dwmapi.dll</span> hooks the
            Windows client and cannot load on the Linux server.
          </li>
          <li>
            <span className="text-slate-200">Visual mods need every client too.</span> Gameplay-data mods (stack
            sizes, drop rates) work server-side; texture, model and UI mods must also be in each player&apos;s
            own <span className="font-mono">~mods</span> folder.
          </li>
          <li>
            <span className="text-slate-200">Console players can still join.</span> Server-side paks do not change
            the world&apos;s listing, and clients without the files connected fine in testing.
          </li>
        </ul>
        <p className="text-[11px] text-slate-500">Mods come from Nexus Mods (the game has no workshop to browse).</p>
      </div>
    </div>
  );
}
