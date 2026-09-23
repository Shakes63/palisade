"use client";
import { useCallback, useEffect, useState } from "react";
import { Boxes, Search, Download, Trash2, Loader2, Info, ExternalLink } from "lucide-react";
import { Game, type ModSearchResult, type MinecraftModpack } from "@ark/shared";
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "@/lib/api";
import { fmtCount } from "@/lib/mod-format";
import { ApiKeyNotice } from "./mods-tab";

/**
 * Minecraft mods = a CurseForge modpack. Browse the Modpacks section, install one,
 * and the itzg image downloads the pack (loader + every mod) on the next start via
 * AUTO_CURSEFORGE. Needs the CurseForge API key configured in Settings.
 */
export function MinecraftModsTab({ serverId }: { serverId: string }) {
  const [current, setCurrent] = useState<MinecraftModpack | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ModSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | "clear" | "update" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);

  const loadCurrent = useCallback(() => {
    apiGet<MinecraftModpack | null>(`/servers/${serverId}/minecraft/modpack`)
      .then(setCurrent)
      .catch(() => undefined);
  }, [serverId]);

  useEffect(() => loadCurrent(), [loadCurrent]);
  useEffect(() => {
    apiGet<{ configured: boolean }>(`/mods/key-status?game=${Game.MINECRAFT}`)
      .then((r) => setKeyConfigured(r.configured))
      .catch(() => undefined);
  }, []);

  const search = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      try {
        const r = await apiGet<ModSearchResult[]>(
          `/mods/browse?game=${Game.MINECRAFT}&query=${encodeURIComponent(q)}`,
        );
        setResults(r);
      } catch (e) {
        setError((e as Error).message);
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Load popular modpacks on open (empty query → CurseForge returns popular).
  useEffect(() => {
    if (keyConfigured) void search("");
  }, [keyConfigured, search]);

  const install = async (m: ModSearchResult) => {
    if (!m.slug) {
      setError("This pack has no installable slug.");
      return;
    }
    setBusyId(m.remoteId);
    setError(null);
    try {
      const saved = await apiPut<MinecraftModpack>(`/servers/${serverId}/minecraft/modpack`, {
        projectId: m.remoteId,
        slug: m.slug,
        name: m.name,
        thumbnailUrl: m.thumbnailUrl,
      });
      setCurrent(saved);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const clear = async () => {
    if (!confirm(`Remove the ${current?.name ?? ""} modpack from this server?`)) return;
    setBusyId("clear");
    try {
      await apiDelete(`/servers/${serverId}/minecraft/modpack`);
      setCurrent(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const updatePack = async () => {
    setBusyId("update");
    setError(null);
    try {
      setCurrent(await apiPost<MinecraftModpack>(`/servers/${serverId}/minecraft/modpack/update`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
          <Boxes className="h-4 w-4" /> CurseForge modpack
        </h3>
        {current ? (
          <div className="flex items-center gap-3 rounded-md border border-ark-accent/40 bg-ark-bg px-3 py-2">
            {current.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={current.thumbnailUrl} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
            ) : (
              <Boxes className="h-12 w-12 shrink-0 rounded bg-ark-panel p-2 text-slate-500" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-slate-100">{current.name}</span>
                <span className="shrink-0 rounded bg-ark-accent/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ark-accent">
                  Installed
                </span>
              </div>
              <div className="text-xs text-slate-500">
                {current.fileId
                  ? "Pinned to a specific pack version · installs on next start."
                  : "Follows the latest pack release automatically on each start."}
              </div>
              {current.updateAvailable && (
                <div className="mt-1 text-xs font-medium text-amber-400">
                  Newer version available{current.latestFileName ? `: ${current.latestFileName}` : ""}
                </div>
              )}
            </div>
            {current.updateAvailable && (
              <button
                className="shrink-0 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
                onClick={updatePack}
                disabled={busyId !== null}
              >
                {busyId === "update" ? "Updating…" : "Update pack"}
              </button>
            )}
            <button
              className="shrink-0 px-1.5 text-slate-500 hover:text-rose-400"
              title="Remove"
              aria-label={`Remove ${current.name}`}
              onClick={clear}
              disabled={busyId !== null}
            >
              {busyId === "clear" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            No modpack — the server runs the type chosen under{" "}
            <span className="font-mono text-slate-300">Settings → Server</span>. Pick a modpack below to install
            it (loader + every mod) automatically.
          </p>
        )}
      </div>

      {keyConfigured === false && <ApiKeyNotice service="CurseForge" what="browse and install modpacks" />}

      {keyConfigured && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void search(query);
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
              <input
                className="input pl-8"
                placeholder="Search CurseForge modpacks (e.g. All the Mods, Better MC)…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button className="btn-primary" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
            </button>
          </form>
    
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
    
          {loading && results.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {results.map((m) => {
                const installed = current?.projectId === m.remoteId;
                return (
                  <div key={m.remoteId} className="card flex min-w-0 gap-3">
                    {m.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.thumbnailUrl} alt="" className="h-16 w-16 shrink-0 rounded object-cover" />
                    ) : (
                      <Boxes className="h-16 w-16 shrink-0 rounded bg-ark-panel p-3 text-slate-500" />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-start justify-between gap-2">
                        <span className="truncate font-medium text-slate-100">{m.name}</span>
                        {m.websiteUrl && (
                          <a
                            href={m.websiteUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-slate-500 hover:text-slate-300"
                            title="Open on CurseForge"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                      <p className="line-clamp-2 text-xs text-slate-400">{m.summary}</p>
                      <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                        <span className="text-[11px] text-slate-500">
                          <Download className="mr-1 inline h-3 w-3" />
                          {fmtCount(m.downloadCount)}
                        </span>
                        <button
                          className="btn-secondary"
                          onClick={() => install(m)}
                          disabled={busyId !== null || installed || !m.slug}
                        >
                          {busyId === m.remoteId ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}{" "}
                          {installed ? "Installed" : "Install"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {!loading && results.length === 0 && !error && (
                <p className="text-xs text-slate-500">No modpacks found. Try a different search.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
