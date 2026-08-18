"use client";
import { useEffect, useState } from "react";
import { Boxes, Save, Check, ChevronDown, Loader2 } from "lucide-react";
import {
  ServerState,
  GAME_VERSION_PINNING,
  resolveVersionTag,
  GAME_LABELS,
  type ImageTagsResult,
  type ServerSummary,
} from "@ark/shared";
import { apiGet, apiPatch } from "@/lib/api";

/**
 * Advanced: pin the game's Docker image to a specific tag (e.g. roll back to a prior
 * version) instead of the shipped default. Editable only while stopped — the new tag
 * is pulled and the container recreated on the next start. Collapsed by default.
 */
export function ImageVersionCard({ server, onSaved }: { server: ServerSummary; onSaved: () => void }) {
  const stopped = server.state === ServerState.Stopped || server.state === ServerState.Crashed;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ImageTagsResult | null>(null);
  const [loading, setLoading] = useState(false);
  // "" means "use the shipped default"; otherwise a pinned tag.
  const [choice, setChoice] = useState<string>(server.imageTag ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Fetched on mount, not on expand: the resolved version badge in the collapsed
    // header is the whole point (GH #26 — "seeing the actual version it will pull
    // would be a better admin experience"). The endpoint is cached server-side per
    // repo for 10 minutes, so this is one cheap call per page view.
    if (data || loading) return;
    setLoading(true);
    apiGet<ImageTagsResult>(`/games/${server.game}/image-tags`)
      .then(setData)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [data, loading, server.game]);

  useEffect(() => setChoice(server.imageTag ?? ""), [server.imageTag]);

  const current = server.imageTag ?? data?.defaultTag ?? "default";
  // A floating tag ("latest") says nothing about WHICH game build you're on. When the
  // registry publishes a versioned alias for the same digest, show it (GH #26).
  const currentVersion = data ? resolveVersionTag(data.tags, current) : null;
  const changed = (server.imageTag ?? "") !== choice;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await apiPatch(`/servers/${server.id}`, { imageTag: choice === "" ? null : choice });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Ensure the currently-pinned tag is always selectable even if the registry list
  // doesn't include it (deleted upstream, or the fetch failed).
  const tags = data?.tags ?? [];
  const names = new Set(tags.map((t) => t.name));
  const extra = server.imageTag && !names.has(server.imageTag) ? [server.imageTag] : [];

  return (
    <div className="card">
      <button
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
          <Boxes className="h-4 w-4" /> Image version
          <span className="ml-1 rounded bg-slate-700/60 px-1.5 py-0.5 font-mono text-[11px] font-normal normal-case text-slate-300">
            {current}
          </span>
          {currentVersion && (
            <span
              className="rounded bg-slate-800/80 px-1.5 py-0.5 font-mono text-[11px] font-normal normal-case text-slate-400"
              title={`"${current}" currently points at ${currentVersion}`}
            >
              {currentVersion}
            </span>
          )}
        </span>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] leading-snug text-slate-500">
            Advanced. Pin the game container to a specific published tag instead of the shipped
            default (<span className="font-mono">{data?.defaultTag ?? "…"}</span>) — useful to roll back a
            bad update. Applied on the next start (the image is pulled and the container recreated).
          </p>
          {/* Per-game: make clear whether the image tag == the game version. */}
          {(() => {
            const kind = GAME_VERSION_PINNING[server.game];
            const label = GAME_LABELS[server.game];
            if (kind === "image-tag") {
              return (
                <p className="rounded-md border border-emerald-900/40 bg-emerald-950/20 px-2.5 py-1.5 text-[11px] leading-snug text-emerald-200/90">
                  For {label}, the image tag <span className="font-semibold">is</span> the game version — pick a
                  version here to change the game itself.
                </p>
              );
            }
            if (kind === "game-version") {
              return (
                <p className="rounded-md border border-sky-900/40 bg-sky-950/20 px-2.5 py-1.5 text-[11px] leading-snug text-sky-200/90">
                  This changes the management image (its runtime/wrapper), <span className="font-semibold">not</span>{" "}
                  the game version. Set {label}&apos;s game version in the <span className="font-semibold">Settings</span> tab.
                </p>
              );
            }
            return (
              <p className="rounded-md border border-amber-900/40 bg-amber-950/20 px-2.5 py-1.5 text-[11px] leading-snug text-amber-200/90">
                {label}&apos;s game version can&apos;t be pinned — the image always installs the latest version
                on start. This dropdown changes the management image only.
              </p>
            );
          })()}
          {err && <div className="text-xs text-rose-300">{err}</div>}

          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input max-w-xs"
              value={choice}
              disabled={!stopped || busy}
              onChange={(e) => setChoice(e.target.value)}
            >
              <option value="">Default ({data?.defaultTag ?? "latest"}) — track the shipped tag</option>
              {loading && <option disabled>Loading versions…</option>}
              {[...extra].map((name) => (
                <option key={name} value={name}>
                  {name} (pinned, not in list)
                </option>
              ))}
              {tags.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {t.updatedAt ? ` — ${new Date(t.updatedAt).toLocaleDateString()}` : ""}
                </option>
              ))}
            </select>
            <button className="btn-secondary" disabled={!stopped || busy || !changed} onClick={save}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : saved ? (
                <Check className="h-4 w-4 text-emerald-400" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saved ? "Saved" : "Save"}
            </button>
          </div>

          {!stopped && (
            <p className="text-[11px] text-amber-400">Stop the server to change its image version.</p>
          )}
          {data && (
            <p className="text-[11px] text-slate-500">
              Repository: <span className="font-mono">{data.repo}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
