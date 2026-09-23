"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Search,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowDownUp,
  Package,
  Download,
  Star,
  Loader2,
  Check,
  Info,
} from "lucide-react";
import {
  Game,
  MOD_PAGE_SIZE,
  type ModCategory,
  type ModFavorite,
  type ModSearchResult,
  type ModSort,
} from "@ark/shared";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { ModDetailModal } from "./mod-detail-modal";
import { fmtBytes, fmtCount, fmtDate } from "@/lib/mod-format";

interface ModInstall {
  id: string;
  loadOrder: number;
  enabled: boolean;
  pinnedVersion: string | null;
  mod: { remoteId: string; name: string; thumbnailUrl: string | null; source: string };
}

export function ModsTab({ serverId, game }: { serverId: string; game: Game }) {
  const isASA = game === Game.ASA;
  const browserName = isASA ? "CurseForge" : "Steam Workshop";

  const [installed, setInstalled] = useState<ModInstall[]>([]);
  const [view, setView] = useState<"installed" | "browse" | "favorites">("installed");
  const [manualId, setManualId] = useState("");
  const [manualIdError, setManualIdError] = useState<string | null>(null);
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);

  // Browse state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ModSearchResult[]>([]);
  const [sort, setSort] = useState<ModSort>("downloads");
  const [gameVersion, setGameVersion] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [featuredOnly, setFeaturedOnly] = useState(false);
  const [categories, setCategories] = useState<ModCategory[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [favorites, setFavorites] = useState<ModFavorite[]>([]);
  const autoLoaded = useRef(false);

  const refresh = useCallback(() => {
    apiGet<ModInstall[]>(`/servers/${serverId}/mods`).then(setInstalled).catch(() => undefined);
  }, [serverId]);
  useEffect(() => refresh(), [refresh]);

  // Persist the mods sub-tab in the URL (?modtab=browse) so a refresh stays put.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("modtab");
    if (p === "installed" || p === "browse" || p === "favorites") setView(p);
  }, []);
  const changeView = (v: "installed" | "browse" | "favorites") => {
    setView(v);
    const u = new URL(window.location.href);
    u.searchParams.set("modtab", v);
    window.history.replaceState(null, "", u);
  };

  useEffect(() => {
    apiGet<{ configured: boolean }>(`/mods/key-status?game=${game}`)
      .then((r) => setKeyConfigured(r.configured))
      .catch(() => undefined);
  }, [game]);

  // Category list for the filter (CurseForge only).
  useEffect(() => {
    if (!isASA || !keyConfigured) return;
    apiGet<ModCategory[]>(`/mods/categories?game=${game}`).then(setCategories).catch(() => undefined);
  }, [game, isASA, keyConfigured]);

  // Favorites (global per game) — stored server-side, work without an API key.
  useEffect(() => {
    apiGet<ModFavorite[]>(`/mods/favorites?game=${game}`).then(setFavorites).catch(() => undefined);
  }, [game]);
  const favIds = new Set(favorites.map((f) => f.remoteId));
  const toggleFavorite = async (m: { remoteId: number; name: string; thumbnailUrl: string | null }) => {
    try {
      setFavorites(
        favIds.has(m.remoteId)
          ? await apiDelete<ModFavorite[]>(`/mods/favorites/${m.remoteId}?game=${game}`)
          : await apiPost<ModFavorite[]>(`/mods/favorites`, {
              game,
              remoteId: m.remoteId,
              name: m.name,
              thumbnailUrl: m.thumbnailUrl,
            }),
      );
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const fetchMods = useCallback(
    async (nextPage: number, append: boolean, ov?: { sort?: ModSort; categoryId?: string }) => {
      const sf = ov?.sort ?? sort;
      const cat = ov?.categoryId ?? categoryId;
      const params = new URLSearchParams({ game, query, page: String(nextPage), sort: sf });
      if (isASA && cat) params.set("categoryId", cat);
      if (isASA && gameVersion.trim()) params.set("gameVersion", gameVersion.trim());
      if (append) setLoadingMore(true);
      else setSearching(true);
      setBrowseError(null);
      try {
        const batch = await apiGet<ModSearchResult[]>(`/mods/browse?${params.toString()}`);
        setResults((prev) => (append ? [...prev, ...batch] : batch));
        setHasMore(batch.length === MOD_PAGE_SIZE);
        setPage(nextPage);
        setHasSearched(true);
      } catch (err) {
        setBrowseError((err as Error).message);
      } finally {
        if (append) setLoadingMore(false);
        else setSearching(false);
      }
    },
    [game, isASA, query, sort, categoryId, gameVersion],
  );

  const changeSort = (s: ModSort) => {
    setSort(s);
    if (hasSearched) fetchMods(0, false, { sort: s });
  };
  const changeCategory = (c: string) => {
    setCategoryId(c);
    if (hasSearched) fetchMods(0, false, { categoryId: c });
  };

  // First time the browser tab is opened, show the top mods (empty query +
  // default "most downloads" sort) so it isn't an empty page.
  useEffect(() => {
    if (view === "browse" && keyConfigured && !autoLoaded.current) {
      autoLoaded.current = true;
      fetchMods(0, false);
    }
  }, [view, keyConfigured, fetchMods]);

  // Featured-only is a client filter (CF flag); "name" falls back to a client
  // sort since Steam has no server-side name ordering.
  const displayed = useMemo(() => {
    let r = results;
    if (featuredOnly) r = r.filter((m) => m.featured);
    if (sort === "name") r = [...r].sort((a, b) => a.name.localeCompare(b.name));
    return r;
  }, [results, featuredOnly, sort]);

  const install = async (remoteId: number, name?: string, thumbnailUrl?: string | null) => {
    try {
      await apiPost(`/servers/${serverId}/mods`, { remoteId, name, thumbnailUrl });
      refresh();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...installed];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setInstalled(next);
    await apiPost(`/servers/${serverId}/mods/reorder`, { order: next.map((m) => m.id) });
    refresh();
  };
  const toggle = async (m: ModInstall) => {
    await apiPatch(`/servers/${serverId}/mods/${m.id}/enabled`, { enabled: !m.enabled });
    refresh();
  };
  const remove = async (m: ModInstall) => {
    if (!confirm(`Remove ${m.mod.name} from this server?`)) return;
    await apiDelete(`/servers/${serverId}/mods/${m.id}`);
    refresh();
  };

  const installedIds = new Set(installed.map((m) => m.mod.remoteId));
  const isInstalled = (id: number) => installedIds.has(String(id));

  return (
    <div className="space-y-4">
      {/* Sub-tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-ark-border">
        <button
          type="button"
          onClick={() => changeView("installed")}
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm sm:px-4 ${
            view === "installed"
              ? "border-b-2 border-ark-accent text-slate-100"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Package className="h-4 w-4 shrink-0" /> Installed
          <span className="rounded-full bg-ark-border px-1.5 text-[10px] text-slate-300">
            {installed.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => changeView("browse")}
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm sm:px-4 ${
            view === "browse"
              ? "border-b-2 border-ark-accent text-slate-100"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Search className="h-4 w-4 shrink-0" /> {browserName}
          <span className="hidden sm:inline">browser</span>
        </button>
        <button
          type="button"
          onClick={() => changeView("favorites")}
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm sm:px-4 ${
            view === "favorites"
              ? "border-b-2 border-ark-accent text-slate-100"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Star className="h-4 w-4 shrink-0" /> Favorites
          {favorites.length > 0 && (
            <span className="rounded-full bg-ark-border px-1.5 text-[10px] text-slate-300">
              {favorites.length}
            </span>
          )}
        </button>
      </div>

      {view === "installed" && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            Load order — mods are applied top-first. Mods here aren&apos;t pinned to a version — the game
            image downloads/updates every listed mod to its latest release on each server start.
          </p>
          {installed.length === 0 && (
            <div className="card text-xs text-slate-500">
              No mods installed yet — add some from the {browserName} browser, or by ID below.
            </div>
          )}
          {installed.map((m, i) => (
            <div key={m.id} className="card flex items-center justify-between gap-3 py-3">
              <div className="flex items-center gap-3">
                <span className="w-6 text-center text-xs text-slate-500">{i + 1}</span>
                <div>
                  <div className={m.enabled ? "" : "line-through opacity-50"}>{m.mod.name}</div>
                  <div className="text-xs text-slate-500">#{m.mod.remoteId}</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button className="btn-secondary px-2" onClick={() => move(i, -1)} disabled={i === 0}>
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  className="btn-secondary px-2"
                  onClick={() => move(i, 1)}
                  disabled={i === installed.length - 1}
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
                <button className="btn-secondary px-2" onClick={() => toggle(m)}>
                  {m.enabled ? "On" : "Off"}
                </button>
                <button
                  className="px-1.5 text-slate-500 hover:text-rose-400"
                  title="Remove"
                  aria-label={`Remove ${m.mod.name}`}
                  onClick={() => remove(m)}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const id = manualId.trim();
              if (!id) return;
              if (!/^\d+$/.test(id)) {
                setManualIdError("A mod ID is a number, e.g. 928793.");
                return;
              }
              install(Number(id));
              setManualId("");
            }}
            className="card space-y-2"
          >
            <div className="flex gap-2">
              <input
                className="input"
                inputMode="numeric"
                placeholder="Add by mod ID (works without an API key)"
                value={manualId}
                onChange={(e) => {
                  setManualId(e.target.value);
                  setManualIdError(null);
                }}
              />
              <button className="btn-primary shrink-0">
                <Plus className="h-4 w-4" /> Add
              </button>
            </div>
            {manualIdError && <p className="text-xs text-amber-400">{manualIdError}</p>}
          </form>
        </div>
      )}

      {view === "favorites" && (
        <div className="space-y-3">
          {favorites.length === 0 ? (
            <div className="card text-xs text-slate-500">
              No favorites yet — tap the ★ on a mod in the {browserName} browser to save it here.
            </div>
          ) : (
            <div className="grid gap-2 lg:grid-cols-2">
              {favorites.map((f) => (
                <div key={f.remoteId} className="card flex min-w-0 items-center justify-between gap-3 py-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-3 text-left"
                    onClick={() => setDetailId(f.remoteId)}
                  >
                    {f.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.thumbnailUrl} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                    ) : null}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{f.name}</span>
                        {isInstalled(f.remoteId) && <InstalledBadge />}
                      </div>
                      <div className="text-xs text-slate-500">#{f.remoteId}</div>
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className="rounded p-1.5 hover:bg-ark-border"
                      title="Unfavorite"
                      onClick={() => toggleFavorite(f)}
                    >
                      <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                    </button>
                    <button
                      className="btn-primary"
                      disabled={isInstalled(f.remoteId)}
                      onClick={() => install(f.remoteId, f.name, f.thumbnailUrl)}
                    >
                      <Download className="h-4 w-4" /> {isInstalled(f.remoteId) ? "Installed" : "Install"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "browse" && keyConfigured === false && (
        <ApiKeyNotice service={isASA ? "CurseForge" : "Steam Web"} what="browse mods" />
      )}

      {view === "browse" && keyConfigured && (
        <div className="space-y-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              fetchMods(0, false);
            }}
            className="flex gap-2"
          >
            <input
              className="input"
              placeholder={`Search ${browserName} mods…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="btn-primary" disabled={searching}>
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}{" "}
              Search
            </button>
          </form>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
            <label className="flex items-center gap-1.5">
              <ArrowDownUp className="h-3.5 w-3.5" /> Sort
              <select
                className="input w-auto py-1 text-xs"
                value={sort}
                onChange={(e) => changeSort(e.target.value as ModSort)}
              >
                <option value="relevance">Relevance</option>
                <option value="popularity">Popularity</option>
                <option value="downloads">Most downloads</option>
                <option value="updated">Recently updated</option>
                <option value="name">Name (A–Z)</option>
              </select>
            </label>
            {isASA && categories.length > 0 && (
              <label className="flex items-center gap-1.5">
                Category
                <select
                  className="input w-auto py-1 text-xs"
                  value={categoryId}
                  onChange={(e) => changeCategory(e.target.value)}
                >
                  <option value="">All</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {isASA && (
              <label className="flex items-center gap-1.5">
                Game version
                <input
                  className="input w-24 py-1 text-xs"
                  placeholder="e.g. 1.0"
                  value={gameVersion}
                  onChange={(e) => setGameVersion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      fetchMods(0, false);
                    }
                  }}
                />
              </label>
            )}
            {isASA && (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={featuredOnly}
                  onChange={(e) => setFeaturedOnly(e.target.checked)}
                />
                Featured only
              </label>
            )}
          </div>

          {browseError && <p className="text-sm text-amber-400">{browseError}</p>}

          <div className="grid gap-3 lg:grid-cols-2">
            {displayed.map((r) => (
              <div
                key={r.remoteId}
                role="button"
                tabIndex={0}
                onClick={() => setDetailId(r.remoteId)}
                onKeyDown={(e) => e.key === "Enter" && setDetailId(r.remoteId)}
                className="card flex min-w-0 cursor-pointer items-start justify-between gap-3 text-left transition-colors hover:border-ark-accent/40"
              >
                <div className="flex min-w-0 gap-3">
                  {r.thumbnailUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.thumbnailUrl} alt="" className="h-14 w-14 shrink-0 rounded object-cover" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{r.name}</span>
                      {r.featured && <Star className="h-3 w-3 shrink-0 text-amber-400" />}
                      {isInstalled(r.remoteId) && <InstalledBadge />}
                    </div>
                    <div className="line-clamp-2 text-xs text-slate-400">{r.summary}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                      {r.authors[0] && <span className="max-w-[8rem] truncate">by {r.authors[0]}</span>}
                      <span>{fmtCount(r.downloadCount)} downloads</span>
                      {r.lastUpdated && <span>upd {fmtDate(r.lastUpdated)}</span>}
                      {r.fileSize ? <span>{fmtBytes(r.fileSize)}</span> : null}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="rounded p-1.5 hover:bg-ark-border"
                    title={favIds.has(r.remoteId) ? "Unfavorite" : "Favorite"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite({ remoteId: r.remoteId, name: r.name, thumbnailUrl: r.thumbnailUrl });
                    }}
                  >
                    <Star
                      className={`h-4 w-4 ${
                        favIds.has(r.remoteId) ? "fill-amber-400 text-amber-400" : "text-slate-500"
                      }`}
                    />
                  </button>
                  <button
                    className="btn-primary"
                    disabled={isInstalled(r.remoteId)}
                    onClick={(e) => {
                      e.stopPropagation();
                      install(r.remoteId, r.name, r.thumbnailUrl);
                    }}
                  >
                    <Download className="h-4 w-4" /> {isInstalled(r.remoteId) ? "Installed" : "Install"}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {hasMore && (
            <div className="flex justify-center">
              <button className="btn-secondary" disabled={loadingMore} onClick={() => fetchMods(page + 1, true)}>
                {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDown className="h-4 w-4" />}{" "}
                Load more
              </button>
            </div>
          )}

          {hasSearched && displayed.length === 0 && !searching && !browseError && (
            <p className="text-xs text-slate-500">No mods match.</p>
          )}
          {!hasSearched && !browseError && (
            <p className="text-xs text-slate-500">Search above to browse {browserName} mods.</p>
          )}
        </div>
      )}

      {detailId !== null && (
        <ModDetailModal
          game={game}
          remoteId={detailId}
          installed={isInstalled(detailId)}
          favorited={favIds.has(detailId)}
          onClose={() => setDetailId(null)}
          onInstall={(d) => install(d.remoteId, d.name, d.thumbnailUrl)}
          onToggleFavorite={(d) =>
            toggleFavorite({ remoteId: d.remoteId, name: d.name, thumbnailUrl: d.thumbnailUrl })
          }
        />
      )}
    </div>
  );
}

/** Shown in place of a mod browser whose API key isn't set in Settings. */
export function ApiKeyNotice({ service, what }: { service: string; what: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        No {service} API key is set. Add one in{" "}
        <Link href="/settings?tab=integrations" className="font-medium underline hover:text-amber-100">
          Settings → Integrations
        </Link>{" "}
        to {what}.
      </span>
    </div>
  );
}

/** Small green pill shown on any mod that's already installed on this server. */
function InstalledBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
      <Check className="h-2.5 w-2.5" /> Installed
    </span>
  );
}
