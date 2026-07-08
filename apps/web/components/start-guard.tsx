"use client";
import { useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRightLeft, Loader2, Zap, X } from "lucide-react";
import { GAME_LABELS, type InsufficientRamInfo } from "@ark/shared";
import { apiPost, ApiError } from "@/lib/api";

const gb = (mb: number) => (mb / 1024).toFixed(1);

function StartGuardDialog({
  info,
  serverName,
  busy,
  onStopAndStart,
  onForce,
  onClose,
}: {
  info: InsufficientRamInfo;
  serverName: string;
  busy: boolean;
  onStopAndStart: (stopId: string) => void;
  onForce: () => void;
  onClose: () => void;
}) {
  // Auto-stop off → just warn. On → offer a swap: one running server is a simple
  // "back it up + shut it down, then start this" confirm; several is a picker.
  const swap = info.autoStop && info.running.length > 0;
  const single = swap && info.running.length === 1;
  const only = info.running[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-md space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <h3 className="font-semibold text-slate-100">Not enough free RAM to start “{serverName}”</h3>
            <p className="mt-0.5 text-sm text-slate-400">
              Needs about <span className="text-slate-200">{gb(info.needMb)} GB</span>, but only{" "}
              <span className="text-slate-200">{gb(info.availableMb)} GB</span> of {gb(info.totalMb)} GB is free.
            </p>
          </div>
        </div>

        {single ? (
          <p className="rounded-md border border-ark-border bg-ark-bg px-3 py-2 text-sm text-slate-300">
            This will <span className="text-slate-100">back up and shut down “{only.name}”</span> (
            {GAME_LABELS[only.game]}), then start “{serverName}”.
            {only.playersOnline != null && only.playersOnline > 0 && (
              <span className="mt-1 block font-medium text-amber-400">
                {only.playersOnline} player{only.playersOnline === 1 ? " is" : "s are"} online on it right now.
              </span>
            )}
          </p>
        ) : swap ? (
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Back up &amp; shut one down, then start:
            </p>
            {info.running.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-md border border-ark-border bg-ark-bg px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-200">{r.name}</div>
                  <div className="text-xs text-slate-500">
                    {GAME_LABELS[r.game]} · {r.ramUsedMb != null ? `${gb(r.ramUsedMb)} GB` : "—"}
                    {r.playersOnline != null && r.playersOnline > 0 && (
                      <span className="font-medium text-amber-400">
                        {" "}· {r.playersOnline} player{r.playersOnline === 1 ? "" : "s"} online
                      </span>
                    )}
                  </div>
                </div>
                <button className="btn-secondary shrink-0" disabled={busy} onClick={() => onStopAndStart(r.id)}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}{" "}
                  Back up &amp; switch
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400">
            {info.running.length > 0
              ? "Auto-stop is off — stop a running server yourself first, or start anyway."
              : "No game servers are running — free up RAM on the host, or start anyway."}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            <X className="h-4 w-4" /> Cancel
          </button>
          <button className="btn-secondary" onClick={onForce} disabled={busy}>
            <Zap className="h-4 w-4" /> Start anyway
          </button>
          {single && (
            <button className="btn-primary" onClick={() => onStopAndStart(only.id)} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />} Back
              up &amp; switch
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Starts servers with a RAM pre-check. The backend returns 409 INSUFFICIENT_RAM
 * (with the running servers) when a start would exceed free host RAM; this surfaces
 * a dialog to stop one (then auto-start the original) or start anyway. Returns a
 * `start(id, name)` to wire to start buttons and a `dialog` node to render once.
 */
export function useStartGuard(onStarted?: () => void) {
  const [guard, setGuard] = useState<{
    info: InsufficientRamInfo;
    serverId: string;
    serverName: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async (
    serverId: string,
    serverName: string,
    opts: { force?: boolean; stopFirst?: string } = {},
  ) => {
    setBusy(true);
    try {
      await apiPost(`/servers/${serverId}/start`, opts);
      setGuard(null);
      onStarted?.();
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        (e.body as InsufficientRamInfo | undefined)?.code === "INSUFFICIENT_RAM"
      ) {
        setGuard({ info: e.body as InsufficientRamInfo, serverId, serverName });
      } else {
        alert((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const dialog: ReactNode = guard ? (
    <StartGuardDialog
      info={guard.info}
      serverName={guard.serverName}
      busy={busy}
      onStopAndStart={(stopId) => start(guard.serverId, guard.serverName, { stopFirst: stopId })}
      onForce={() => start(guard.serverId, guard.serverName, { force: true })}
      onClose={() => setGuard(null)}
    />
  ) : null;

  return { start, dialog, starting: busy };
}
