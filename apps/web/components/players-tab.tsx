"use client";
import { useCallback, useEffect, useState } from "react";
import { Users, UserX, Gavel, ListChecks, Crown, Loader2, RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { fmtLocal } from "@/lib/cron";
import { fmtDate } from "@/lib/mod-format";
import { confirmDialog } from "@/components/dialogs";

type PlayerAction = "kick" | "ban" | "whitelist" | "admin";
interface SeenPlayer {
  name: string;
  playerId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  online: boolean;
  playtimeMinutes: number;
}
interface View {
  players: SeenPlayer[];
  supportedActions: PlayerAction[];
  liveActions: PlayerAction[];
  running: boolean;
  tracked: boolean;
  captureNote: string;
  hourCounts: number[];
  playtimeTracked: boolean;
}

const ACTION_META: Record<PlayerAction, { label: string; icon: typeof Gavel; danger?: boolean; title: string }> = {
  kick: { label: "Kick", icon: UserX, danger: true, title: "Kick this player (they can rejoin)" },
  ban: { label: "Ban", icon: Gavel, danger: true, title: "Ban this player" },
  whitelist: { label: "Whitelist", icon: ListChecks, title: "Add to the whitelist / allow-list" },
  admin: { label: "Admin", icon: Crown, title: "Grant admin / operator" },
};

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const playtime = (minutes: number) => {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${(minutes / 60).toFixed(1)}h`;
  return `${Math.round(minutes / 60)}h`;
};

/** Peak-hours strip: the server's UTC histogram rotated into the browser's timezone. */
function HourHeatmap({ utcCounts }: { utcCounts: number[] }) {
  const offsetHours = Math.round(-new Date().getTimezoneOffset() / 60);
  const local = Array.from({ length: 24 }, (_, h) => utcCounts[(((h - offsetHours) % 24) + 24) % 24] ?? 0);
  const max = Math.max(...local, 1);
  return (
    <div className="card space-y-1 py-3">
      <p className="text-xs font-medium text-slate-400">Activity by hour (your time)</p>
      <div className="flex items-end gap-[2px]">
        {local.map((n, h) => (
          <div key={h} className="flex-1" title={`${String(h).padStart(2, "0")}:00 — ${n} player-minute${n === 1 ? "" : "s"}`}>
            <div
              className="w-full rounded-sm bg-ark-accent"
              style={{ height: `${4 + Math.round((n / max) * 28)}px`, opacity: n === 0 ? 0.12 : 0.35 + 0.65 * (n / max) }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-slate-600">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

/**
 * Everyone who has played on this server — captured from the game's own player
 * list (RCON/telnet) and/or join log lines, with the platform id (SteamID64 /
 * XUID / EOS) when the game exposes one. Actions dispatch game-appropriately:
 * RCON commands where the game has them, access-list files where it doesn't.
 */
export function PlayersTab({ serverId }: { serverId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "<name>:<action>"
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiGet<View>(`/servers/${serverId}/players`)
      .then(setView)
      .catch((e) => setErr((e as Error).message));
  }, [serverId]);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const act = async (name: string, action: PlayerAction) => {
    const meta = ACTION_META[action];
    if (meta.danger && !(await confirmDialog({ title: `${meta.label} ${name}?`, confirmLabel: meta.label, danger: true })))
      return;
    setBusy(`${name}:${action}`);
    setMsg(null);
    setErr(null);
    try {
      const res = await apiPost<{ detail: string }>(`/servers/${serverId}/players/action`, { name, action });
      setMsg(res.detail);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!view) return <div className="text-sm text-slate-400">Loading…</div>;

  const unavailable = (p: SeenPlayer, a: PlayerAction): string | null => {
    if (view.liveActions.includes(a) && !view.running) return "The server isn't running";
    if (a === "kick" && !p.online) return `${p.name} isn't online`;
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2 text-sm text-slate-400">
          <Users className="mt-0.5 h-4 w-4 shrink-0 text-ark-accent" />
          <p>
            {view.tracked && (
              <>
                {view.players.length} player{view.players.length === 1 ? "" : "s"} seen on this server.{" "}
              </>
            )}
            <span className={view.tracked ? "text-xs text-slate-500" : ""}>{view.captureNote}</span>
          </p>
        </div>
        {view.tracked && (
          <button className="btn-secondary whitespace-nowrap" onClick={refresh}>
            <RefreshCw className="h-4 w-4 shrink-0" /> Refresh
          </button>
        )}
      </div>

      {msg && <div className="card border-ark-accent/40 py-2 text-sm text-slate-200">{msg}</div>}
      {err && <div className="card border-rose-500/40 py-2 text-sm text-rose-300">{err}</div>}

      {view.playtimeTracked && view.hourCounts.some((n) => n > 0) && (
        <HourHeatmap utcCounts={view.hourCounts} />
      )}

      {view.players.length === 0 ? (
        view.tracked && (
          <div className="card text-sm text-slate-400">
            Nobody yet — players are recorded automatically when they join (name + platform id where the
            game provides one).
          </div>
        )
      ) : (
        <div className="space-y-2">
          {view.players.map((p) => (
            <div key={p.name} className="card flex flex-wrap items-center gap-3 py-3">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${p.online ? "bg-ark-accent" : "bg-slate-700"}`}
                title={p.online ? "Online now" : "Offline"}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-slate-100" title={p.name}>{p.name}</div>
                <div className="break-words text-xs text-slate-500">
                  {p.playerId ? <span className="break-all font-mono">{p.playerId}</span> : "no platform id yet"} ·{" "}
                  {p.online ? "online now" : <span title={fmtLocal(p.lastSeenAt)}>last seen {ago(p.lastSeenAt)}</span>} ·
                  first seen {fmtDate(p.firstSeenAt)}
                  {view.playtimeTracked && p.playtimeMinutes > 0 && <> · {playtime(p.playtimeMinutes)} played</>}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                {view.supportedActions.map((a) => {
                  const meta = ACTION_META[a];
                  const Icon = meta.icon;
                  const key = `${p.name}:${a}`;
                  const why = unavailable(p, a);
                  return (
                    <button
                      key={a}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                        meta.danger
                          ? "border-rose-900/60 text-rose-300 hover:bg-rose-950/40"
                          : "border-ark-border text-slate-300 hover:border-slate-500"
                      }`}
                      title={why ?? meta.title}
                      disabled={busy !== null || why !== null}
                      onClick={() => act(p.name, a)}
                    >
                      {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
                      {meta.label}
                    </button>
                  );
                })}
                {view.supportedActions.length === 0 && (
                  <span className="text-xs text-slate-600">capture only</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {view.supportedActions.some((a) => a !== "kick") && (
        <p className="text-[11px] text-slate-500">
          Whitelist/ban/admin additions land on the game&apos;s own lists — manage or remove entries in the
          Players &amp; access card on the Overview (file-list games) or via the Console (RCON games).
        </p>
      )}
    </div>
  );
}
