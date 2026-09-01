"use client";
import { useCallback, useEffect, useState } from "react";
import { Boxes, Save, Check, ChevronDown, Loader2, ArrowUpCircle, RefreshCw } from "lucide-react";
import {
  ServerState,
  GAME_VERSION_PINNING,
  resolveVersionTag,
  GAME_LABELS,
  type GameBuildStatus,
  type ImageTagsResult,
  type ServerSummary,
  type UpdateGameResult,
} from "@ark/shared";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

/**
 * Version & updates: where this server's game build stands against the latest
 * published one (and how to move it), plus the advanced image-tag pin. Both live
 * here because "what version am I on?" is one question — the card used to answer
 * only the Docker half of it, which left the game build invisible.
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
          <Boxes className="h-4 w-4" /> Version &amp; updates
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
          {server.updateAvailable && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-amber-400">
              Game update available
            </span>
          )}
        </span>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <GameBuildBlock server={server} onChanged={onSaved} />

          <div className="space-y-3 border-t border-ark-border pt-3">
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
        </div>
      )}
    </div>
  );
}

/**
 * The game build itself: what's on disk, what Steam publishes, and the one button
 * that closes the gap. Every image downloads its own game files at boot, so an
 * update is always "arm it, then boot" — the copy says so per game rather than
 * leaving people to guess why a click didn't move the version.
 */
function GameBuildBlock({ server, onChanged }: { server: ServerSummary; onChanged: () => void }) {
  const [status, setStatus] = useState<GameBuildStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [arming, setArming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setStatus(await apiGet<GameBuildStatus>(`/servers/${server.id}/build-status`));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isLive = server.state === ServerState.Running || server.state === ServerState.Starting;
  // The mode rides along on the build status the card already fetches, so the UI
  // keeps no second copy of how each game updates.
  const mode = status?.mode;
  const label = GAME_LABELS[server.game];

  const update = async () => {
    setConfirming(false);
    setArming(true);
    setNote(null);
    try {
      const res = await apiPost<UpdateGameResult>(`/servers/${server.id}/update-game`);
      setNote(res.message);
      onChanged();
      void load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setArming(false);
    }
  };

  const verdict =
    status?.outdated === true
      ? { text: "Update available", cls: "text-amber-400" }
      : status?.outdated === false
        ? { text: "Up to date", cls: "text-emerald-400" }
        : { text: "Unknown", cls: "text-slate-400" };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-slate-300">Game build</span>
        <button
          className="text-slate-400 hover:text-slate-200 disabled:opacity-50"
          onClick={() => void load()}
          disabled={loading}
          title="Check Steam for the latest build"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>
          Installed:{" "}
          <span className="font-mono text-slate-200">{status?.installed ?? "unknown"}</span>
        </span>
        <span>
          Latest: <span className="font-mono text-slate-200">{status?.latest ?? "unknown"}</span>
        </span>
        <span className={verdict.cls}>{verdict.text}</span>
      </div>

      {status && status.installed === null && status.appId !== null && (
        <p className="text-[11px] leading-snug text-slate-500">
          No SteamCMD manifest on disk yet — the build id appears once the server has started and
          installed its game files at least once.
        </p>
      )}

      {mode && (
        <p className="text-[11px] leading-snug text-slate-500">
          {mode === "image"
            ? `${label}'s game files ship inside the Docker image, so updating means pulling a newer image and recreating the container.`
            : mode === "on-request"
              ? `The ${label} image only runs SteamCMD when asked. Update game requests exactly one update, applied on the next boot — or turn on “Update game files on start” in Settings → Version to update on every start.`
              : `The ${label} image installs and updates its game files while the container boots, so a restart is the update.`}
        </p>
      )}

      {err && <div className="text-xs text-rose-300">{err}</div>}
      {note && (
        <div className="rounded-md border border-sky-900/40 bg-sky-950/20 px-2.5 py-1.5 text-[11px] leading-snug text-sky-200/90">
          {note}
        </div>
      )}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-amber-400">
            Restarts the server — players are disconnected and the new build downloads during boot.
          </span>
          <button className="btn-primary" onClick={() => void update()}>
            Restart &amp; update
          </button>
          <button className="btn-secondary" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="btn-secondary"
          disabled={arming}
          onClick={() => (isLive ? setConfirming(true) : void update())}
        >
          {arming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />}{" "}
          {arming ? "Updating…" : "Update game"}
        </button>
      )}
    </div>
  );
}
