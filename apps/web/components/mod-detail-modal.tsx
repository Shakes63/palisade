"use client";
import { useEffect, useState } from "react";
import { X, Download, ExternalLink, Loader2, Star } from "lucide-react";
import { Game, type ModDetail } from "@ark/shared";
import { apiGet } from "@/lib/api";
import { fmtBytes, fmtCount, fmtDate } from "@/lib/mod-format";

/** Full-screen mod detail: screenshots, full description, metadata, install. */
export function ModDetailModal({
  game,
  remoteId,
  installed,
  favorited,
  onClose,
  onInstall,
  onToggleFavorite,
}: {
  game: Game;
  remoteId: number;
  installed: boolean;
  favorited: boolean;
  onClose: () => void;
  onInstall: (d: ModDetail) => void;
  onToggleFavorite: (d: ModDetail) => void;
}) {
  const [detail, setDetail] = useState<ModDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    apiGet<ModDetail>(`/mods/${remoteId}?game=${game}`)
      .then(setDetail)
      .catch((e) => setError((e as Error).message));
  }, [game, remoteId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
      onClick={onClose}
    >
      <div className="card my-4 w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold">{detail?.name ?? (error ? "Couldn’t load mod" : "Loading…")}</h3>
          <button className="btn-secondary px-2" onClick={onClose} title="Close" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="text-sm text-amber-400">{error}</p>}
        {!detail && !error && (
          <div className="flex items-center gap-2 py-10 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading mod…
          </div>
        )}

        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
              {detail.authors.length > 0 && <span>by {detail.authors.join(", ")}</span>}
              <span>{fmtCount(detail.downloadCount)} downloads</span>
              {detail.lastUpdated && <span>updated {fmtDate(detail.lastUpdated)}</span>}
              {detail.fileSize ? <span>{fmtBytes(detail.fileSize)}</span> : null}
              {detail.version && <span>{detail.version}</span>}
              {detail.featured && (
                <span className="inline-flex items-center gap-1 text-amber-400">
                  <Star className="h-3 w-3" /> Featured
                </span>
              )}
              <span className="text-slate-600">#{detail.remoteId}</span>
            </div>

            {detail.categories.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {detail.categories.map((c) => (
                  <span key={c} className="rounded-full bg-ark-border px-2 py-0.5 text-[11px] text-slate-300">
                    {c}
                  </span>
                ))}
              </div>
            )}

            {detail.screenshots.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {detail.screenshots.slice(0, 12).map((url) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={url}
                    src={url}
                    alt=""
                    className="h-40 shrink-0 rounded border border-ark-border object-cover"
                  />
                ))}
              </div>
            )}

            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-ark-bg/60 p-3 text-sm leading-relaxed text-slate-300">
              {detail.description || "No description provided."}
            </div>

            <div className="flex items-center justify-between gap-2">
              {detail.websiteUrl ? (
                <a
                  href={detail.websiteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-ark-accent hover:underline"
                >
                  <ExternalLink className="h-4 w-4" /> Open on {game === Game.ASA ? "CurseForge" : "Steam"}
                </a>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button type="button" className="btn-secondary" onClick={() => onToggleFavorite(detail)}>
                  <Star className={`h-4 w-4 ${favorited ? "fill-amber-400 text-amber-400" : ""}`} />
                  {favorited ? "Favorited" : "Favorite"}
                </button>
                <button className="btn-primary" disabled={installed} onClick={() => onInstall(detail)}>
                  <Download className="h-4 w-4" /> {installed ? "Installed" : "Install"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
