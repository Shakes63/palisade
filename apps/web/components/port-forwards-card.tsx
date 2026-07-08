"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Globe, Check, X, Loader2, ArrowUpRight, Power, Trash2, TriangleAlert } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api";

type ForwardState = "ok" | "disabled" | "mismatched" | "missing";
interface ForwardStatus {
  port: number;
  proto: "udp" | "tcp";
  label: string;
  state: ForwardState;
  ruleId: number | null;
  actualTarget?: string | null;
}
interface View {
  configured: boolean;
  targetIp: string | null;
  wanIp: string | null;
  forwards: ForwardStatus[];
}

/**
 * Full WAN port-forward management for this server's player-facing ports:
 * per-forward state (ok / disabled / wrong target / missing), one-click
 * create-and-fix, per-forward enable/disable and delete — all against the pfSense
 * REST API (host + key + target IP in Settings).
 */
export function PortForwardsCard({ serverId }: { serverId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "apply" | "<port>/<proto>"
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiGet<View>(`/servers/${serverId}/portforwards`)
      .then(setView)
      .catch((e) => setErr((e as Error).message));
  }, [serverId]);
  useEffect(() => refresh(), [refresh]);

  const run = async (key: string, fn: () => Promise<View>) => {
    setBusy(key);
    setErr(null);
    try {
      setView(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!view) return null;
  const fixable = view.forwards.filter((f) => f.state === "missing" || f.state === "mismatched").length;

  const stateChip = (f: ForwardStatus) => {
    switch (f.state) {
      case "ok":
        return (
          <span className="inline-flex items-center gap-1 text-xs text-ark-accent">
            <Check className="h-3.5 w-3.5" /> forwarded
          </span>
        );
      case "disabled":
        return (
          <span className="inline-flex items-center gap-1 text-xs text-slate-500">
            <Power className="h-3.5 w-3.5" /> disabled
          </span>
        );
      case "mismatched":
        return (
          <span className="inline-flex items-center gap-1 text-xs text-amber-400" title={`Currently → ${f.actualTarget}`}>
            <TriangleAlert className="h-3.5 w-3.5" /> wrong target ({f.actualTarget})
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 text-xs text-rose-400">
            <X className="h-3.5 w-3.5" /> not forwarded
          </span>
        );
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-ark-accent" />
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            Port forwarding (pfSense)
          </h3>
        </div>
        {view.configured && fixable > 0 && (
          <button className="btn-primary" onClick={() => run("apply", () => apiPost<View>(`/servers/${serverId}/portforwards`))} disabled={busy !== null}>
            {busy === "apply" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
            {busy === "apply" ? "Applying…" : `Fix ${fixable} forward${fixable === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {!view.configured ? (
        <p className="text-xs text-slate-500">
          Set the pfSense host, API key, and target IP in{" "}
          <Link href="/settings" className="text-ark-accent hover:underline">
            Settings
          </Link>{" "}
          to manage WAN forwards from here.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-ark-border/50">
            {view.forwards.map((f) => {
              const key = `${f.port}/${f.proto}`;
              const rowBusy = busy === key;
              return (
                <li key={key} className="flex items-center gap-2 py-1.5">
                  <span className="w-24 shrink-0 font-mono text-sm text-slate-200">{key}</span>
                  <span className="w-40 shrink-0 truncate text-xs text-slate-500">{f.label}</span>
                  <span className="min-w-0 flex-1">{stateChip(f)}</span>
                  {rowBusy ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-500" />
                  ) : (
                    f.ruleId != null && (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          className="text-slate-500 hover:text-slate-200"
                          title={f.state === "disabled" ? "Enable this forward" : "Disable this forward (rule kept)"}
                          disabled={busy !== null}
                          onClick={() =>
                            run(key, () =>
                              apiPatch<View>(`/servers/${serverId}/portforwards`, {
                                port: f.port,
                                proto: f.proto,
                                enabled: f.state === "disabled",
                              }),
                            )
                          }
                        >
                          <Power className="h-4 w-4" />
                        </button>
                        <button
                          className="text-slate-500 hover:text-rose-400"
                          title="Delete this forward from pfSense"
                          disabled={busy !== null}
                          onClick={() =>
                            run(key, () =>
                              apiDelete<View>(
                                `/servers/${serverId}/portforwards?port=${f.port}&proto=${f.proto}`,
                              ),
                            )
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </span>
                    )
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-slate-500">
            Internet{view.wanIp ? <> (WAN <span className="font-mono text-slate-400">{view.wanIp}</span>)</> : ""} →{" "}
            <span className="font-mono text-slate-400">{view.targetIp}</span> on your LAN. Friends connect to the
            WAN address. Admin ports (RCON/telnet) are deliberately never forwarded.
            {fixable === 0 && " All player-facing ports are forwarded."}
          </p>
        </>
      )}
      {err && <p className="text-xs text-rose-400">{err}</p>}
    </div>
  );
}
