"use client";
import { useCallback, useEffect, useState } from "react";
import { Users, UserX, Gavel, ListChecks, Crown, Loader2, RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";

type PlayerAction = "kick" | "ban" | "whitelist" | "admin";
interface SeenPlayer {
  name: string;
  playerId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  online: boolean;
}
interface View {
  players: SeenPlayer[];
  supportedActions: PlayerAction[];
  captureNote: string;
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
    if (meta.danger && !confirm(`${meta.label} ${name}?`)) return;
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

  if (!view) return <div className="text-slate-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <Users className="h-4 w-4 text-ark-accent" />
          {view.players.length} player{view.players.length === 1 ? "" : "s"} seen on this server.{" "}
          <span className="text-xs text-slate-500">{view.captureNote}</span>
        </p>
        <button className="btn-secondary" onClick={refresh}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {msg && <div className="card border-ark-accent/40 py-2 text-sm text-slate-200">{msg}</div>}
      {err && <div className="card border-rose-500/40 py-2 text-sm text-rose-300">{err}</div>}

      {view.players.length === 0 ? (
        <div className="card text-slate-400">
          Nobody yet — players are recorded automatically when they join (name + platform id where the
          game provides one).
        </div>
      ) : (
        <div className="space-y-2">
          {view.players.map((p) => (
            <div key={p.name} className="card flex flex-wrap items-center gap-3 py-3">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${p.online ? "bg-ark-accent" : "bg-slate-700"}`}
                title={p.online ? "Online now" : "Offline"}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-slate-100">{p.name}</div>
                <div className="truncate text-xs text-slate-500">
                  {p.playerId ? <span className="font-mono">{p.playerId}</span> : "no platform id yet"} ·{" "}
                  {p.online ? "online now" : `last seen ${ago(p.lastSeenAt)}`} · first{" "}
                  {new Date(p.firstSeenAt).toLocaleDateString()}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                {view.supportedActions.map((a) => {
                  const meta = ACTION_META[a];
                  const Icon = meta.icon;
                  const key = `${p.name}:${a}`;
                  return (
                    <button
                      key={a}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                        meta.danger
                          ? "border-rose-900/60 text-rose-300 hover:bg-rose-950/40"
                          : "border-ark-border text-slate-300 hover:border-slate-500"
                      }`}
                      title={meta.title}
                      disabled={busy !== null}
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
      <p className="text-[11px] text-slate-500">
        Whitelist/ban/admin additions land on the game&apos;s own lists — manage or remove entries in the
        Players &amp; access card on the Overview (file-list games) or via the Console (RCON games).
      </p>
    </div>
  );
}
