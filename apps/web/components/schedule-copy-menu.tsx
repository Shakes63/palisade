"use client";
import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { GAME_LABELS, type ServerSummary } from "@ark/shared";
import { apiGet, apiPost } from "@/lib/api";
import { toast } from "@/components/dialogs";

/** Copy one schedule onto other servers, of any game (GH #157). The API skips a
 *  server whose game can't run the action and names it in the reply. */
export function ScheduleCopyMenu({ scheduleId, serverId }: { scheduleId: string; serverId: string }) {
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setSel(new Set());
  };

  useEffect(() => {
    if (!open) return;
    apiGet<ServerSummary[]>("/servers").then(setServers).catch(() => undefined);
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const others = servers.filter((s) => s.id !== serverId);
  const pick = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const run = async () => {
    setBusy(true);
    try {
      const { copied, skipped } = await apiPost<{ copied: number; skipped: string[] }>(
        `/schedules/${scheduleId}/copy`,
        { targetIds: [...sel] },
      );
      toast.success(
        `Copied to ${copied} server(s).` +
          (skipped.length ? ` Skipped ${skipped.join(", ")}: the game can't run this action.` : ""),
      );
      close();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="btn-secondary"
        title="Copy to other servers"
        aria-label="Copy schedule to other servers"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Copy className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-md border border-ark-border bg-ark-panel p-3 shadow-xl">
          <p className="text-xs text-slate-400">Copy this schedule to:</p>
          <div className="max-h-56 space-y-0.5 overflow-auto">
            {others.length === 0 ? (
              <p className="px-1 py-2 text-[12px] text-slate-500">No other servers to copy to.</p>
            ) : (
              others.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-ark-border"
                >
                  <input type="checkbox" checked={sel.has(s.id)} onChange={() => pick(s.id)} />
                  <span className="flex-1 truncate text-slate-200">{s.name}</span>
                  <span className="shrink-0 text-[10px] text-slate-500">{GAME_LABELS[s.game]}</span>
                </label>
              ))
            )}
          </div>
          <button
            type="button"
            className="btn-primary w-full justify-center py-1.5 text-sm"
            disabled={busy || sel.size === 0}
            onClick={run}
          >
            {busy ? "Copying…" : `Copy to ${sel.size || ""} server(s)`}
          </button>
        </div>
      )}
    </div>
  );
}
