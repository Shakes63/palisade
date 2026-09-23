"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Download, Trash2, Package, Loader2, TriangleAlert, ExternalLink } from "lucide-react";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { fmtCount } from "@/lib/mod-format";
import { confirmDialog } from "@/components/dialogs";

interface TsResult {
  name: string;
  fullName: string;
  owner: string;
  description: string;
  icon: string;
  versionNumber: string;
  downloads: number;
  rating: number;
  categories: string[];
  packageUrl: string;
}
type SearchResp = { total: number; page: number; pageSize: number; results: TsResult[] };
interface InstalledMod {
  name: string;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
}
type Status = { mods: InstalledMod[] };

/**
 * Valheim mod browser backed by Thunderstore (the Valheim mod DB). Search installs
 * the mod (+ its dependencies) into config/bepinex/plugins and auto-enables BepInEx.
 * Every connecting player still needs the same mods locally.
 */
export function ValheimModsTab({ serverId }: { serverId: string }) {
  const [query, setQuery] = useState("");
  const [resp, setResp] = useState<SearchResp | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStatus = useCallback(() => {
    apiGet<Status>(`/servers/${serverId}/valheimmods`).then(setStatus).catch(() => undefined);
  }, [serverId]);

  const runSearch = useCallback(
    async (q: string) => {
      setLoading(true);
      setErr(null);
      try {
        const r = await apiGet<SearchResp>(
          `/servers/${serverId}/valheimmods/search?q=${encodeURIComponent(q)}`,
        );
        setResp(r);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [serverId],
  );

  useEffect(() => {
    loadStatus();
    void runSearch("");
  }, [loadStatus, runSearch]);

  // Debounced search as the user types.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void runSearch(query), 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, runSearch]);

  const installed = new Set((status?.mods ?? []).map((m) => m.name));

  const install = async (fullName: string) => {
    setInstalling(fullName);
    setErr(null);
    try {
      const s = await apiPost<Status>(`/servers/${serverId}/valheimmods/install`, { fullName });
      setStatus(s);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setInstalling(null);
    }
  };

  const remove = async (name: string) => {
    if (!(await confirmDialog({ title: `Remove ${name} from this server?`, confirmLabel: "Remove", danger: true }))) return;
    try {
      setStatus(await apiDelete<Status>(`/servers/${serverId}/valheimmods/mods/${encodeURIComponent(name)}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const outdated = (status?.mods ?? []).filter((m) => m.updateAvailable);
  const [updatingAll, setUpdatingAll] = useState(false);
  const updateAll = async () => {
    setUpdatingAll(true);
    setErr(null);
    try {
      await apiPost(`/servers/${serverId}/mod-updates/apply`);
      loadStatus();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUpdatingAll(false);
    }
  };

  return (
    <div className="space-y-4">
      {err && <div className="card border-rose-500/40 text-sm text-rose-300">{err}</div>}

      {/* Installed */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            <Package className="h-4 w-4" /> Installed mods {status && `(${status.mods.length})`}
          </h3>
          {outdated.length > 0 && (
            <button
              className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
              disabled={updatingAll || installing !== null}
              onClick={updateAll}
            >
              {updatingAll ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…
                </span>
              ) : (
                `Update all (${outdated.length})`
              )}
            </button>
          )}
        </div>
        {status && status.mods.length > 0 ? (
          <ul className="divide-y divide-ark-border/50 text-sm">
            {status.mods.map((m) => (
              <li key={m.name} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate font-mono text-slate-200">
                  {m.name}
                  {m.installedVersion && (
                    <span className="ml-1.5 text-xs text-slate-500">v{m.installedVersion}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {m.updateAvailable && (
                    <button
                      className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
                      title={`Update to v${m.latestVersion}`}
                      disabled={installing === m.name}
                      onClick={() => install(m.name)}
                    >
                      {installing === m.name ? "Updating…" : `Update → v${m.latestVersion}`}
                    </button>
                  )}
                  <button
                    className="text-slate-500 hover:text-rose-400"
                    title="Remove"
                    aria-label={`Remove ${m.name}`}
                    onClick={() => remove(m.name)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">
            No mods installed. Search Thunderstore below — installing auto-enables BepInEx and pulls in each
            mod&apos;s dependencies. Restart the server to load changes.
          </p>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          className="input pl-9"
          placeholder="Search Thunderstore mods (e.g. Jotunn, Craft From Containers)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && !resp ? (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading Thunderstore…
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {resp?.results.map((m) => {
            const isInstalled = installed.has(m.fullName);
            return (
              <div key={m.fullName} className="card flex min-w-0 gap-3">
                {m.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.icon} alt="" className="h-14 w-14 shrink-0 rounded-md bg-black/30" />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-black/30">
                    <Package className="h-6 w-6 text-slate-600" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-slate-100">{m.name}</span>
                    <a
                      href={m.packageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-slate-500 hover:text-slate-300"
                      title="View on Thunderstore"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                  <p className="text-xs text-slate-500">
                    by {m.owner} · {fmtCount(m.downloads)} downloads
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs leading-snug text-slate-400">{m.description}</p>
                  <div className="mt-2">
                    <button
                      className="btn-secondary text-xs"
                      disabled={installing === m.fullName || isInstalled}
                      onClick={() => install(m.fullName)}
                    >
                      {installing === m.fullName ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      {isInstalled ? "Installed" : installing === m.fullName ? "Installing…" : "Install"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {resp && resp.results.length === 0 && (
            <p className="text-xs text-slate-500">No mods match “{query}”.</p>
          )}
        </div>
      )}

      <div className="card space-y-2 border-amber-500/30">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-300">
          <TriangleAlert className="h-4 w-4" /> Valheim mod notes
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-xs leading-snug text-slate-400">
          <li>
            <span className="text-slate-200">Everyone needs the same mods.</span> Each player installs the same
            Thunderstore mods locally (via r2modman / Thunderstore Mod Manager), or they can&apos;t join.
          </li>
          <li>
            <span className="text-slate-200">BepInEx is enabled automatically</span> when you install a mod
            here. Restart the server to load new or removed mods.
          </li>
        </ul>
      </div>
    </div>
  );
}
