"use client";
import { useEffect, useState } from "react";
import { Loader2, RotateCcw, X } from "lucide-react";
import type { ArtworkKind, ArtworkOption, Game, GameArtwork, ServerSummary } from "@ark/shared";
import { apiGet, apiPatch } from "@/lib/api";

const KINDS: { key: ArtworkKind; label: string; aspect: string }[] = [
  { key: "grid", label: "Cover", aspect: "aspect-[2/3]" },
  { key: "hero", label: "Banner", aspect: "aspect-[16/6]" },
  { key: "logo", label: "Logo", aspect: "aspect-[3/2]" },
  { key: "icon", label: "Icon", aspect: "aspect-square" },
];

/**
 * Per-server artwork picker. Browses SteamGridDB candidates for the server's
 * game and PATCHes the chosen URL as a per-server override (or clears it back to
 * the game default). Onscreen art = override ?? game default, so a pick shows
 * immediately once the parent refreshes.
 */
export function ArtworkPicker({
  serverId,
  game,
  current,
  onClose,
  onSaved,
}: {
  serverId: string;
  game: Game;
  current: GameArtwork | null | undefined;
  onClose: () => void;
  onSaved: (updated: ServerSummary) => void;
}) {
  const [kind, setKind] = useState<ArtworkKind>("grid");
  const [options, setOptions] = useState<ArtworkOption[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setOptions(null);
    setErr(null);
    apiGet<ArtworkOption[]>(`/artwork/options/${game}?kind=${kind}`)
      .then(setOptions)
      .catch((e) => {
        setOptions([]);
        setErr((e as Error).message);
      });
  }, [game, kind]);

  const pick = async (url: string | null) => {
    setSaving(true);
    setErr(null);
    try {
      const updated = await apiPatch<ServerSummary>(`/servers/${serverId}/artwork`, { [kind]: url });
      onSaved(updated);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const meta = KINDS.find((k) => k.key === kind)!;
  const selected = current?.[kind] ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-ark-border bg-ark-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ark-border p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            Choose artwork
          </h3>
          <button className="text-slate-400 hover:text-slate-200" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-ark-border px-4 pt-3">
          {KINDS.map((k) => (
            <button
              key={k.key}
              className={`rounded-t px-3 py-1.5 text-sm ${
                kind === k.key ? "bg-ark-bg font-medium text-slate-100" : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setKind(k.key)}
            >
              {k.label}
            </button>
          ))}
          <button
            className="ml-auto mb-1 inline-flex items-center gap-1 self-end text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
            onClick={() => pick(null)}
            disabled={saving || !selected}
            title="Reset this to the game default"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to default
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {err && <p className="mb-3 text-sm text-rose-300">{err}</p>}
          {options === null ? (
            <div className="flex items-center justify-center gap-2 py-12 text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading options…
            </div>
          ) : options.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-400">
              No {meta.label.toLowerCase()} options found for this game.
            </p>
          ) : (
            <div className={`grid gap-3 ${kind === "hero" ? "grid-cols-2" : "grid-cols-3 sm:grid-cols-4"}`}>
              {options.map((o) => {
                const active = selected === o.url;
                return (
                  <button
                    key={o.url}
                    className={`group relative overflow-hidden rounded-lg ring-2 transition ${
                      active ? "ring-ark-accent" : "ring-transparent hover:ring-slate-500"
                    }`}
                    onClick={() => pick(o.url)}
                    disabled={saving}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={o.thumb}
                      alt=""
                      className={`w-full ${meta.aspect} bg-ark-bg object-contain`}
                      loading="lazy"
                    />
                    {active && (
                      <span className="absolute right-1 top-1 rounded bg-ark-accent px-1.5 py-0.5 text-[10px] font-medium text-black">
                        current
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {saving && (
          <div className="flex items-center gap-2 border-t border-ark-border px-4 py-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Saving…
          </div>
        )}
      </div>
    </div>
  );
}
