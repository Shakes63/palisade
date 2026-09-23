"use client";
import { useState } from "react";
import { KeyRound, Save, Check, Eye, EyeOff } from "lucide-react";
import { ServerState, ADMIN_PASSWORD_META, JOIN_PASSWORD_META, type ServerSummary } from "@ark/shared";
import { apiPatch } from "@/lib/api";

/** Set / change / remove a server's join + admin passwords. Works for every game
 *  (the API stores them encrypted and delivers them to the container on start). */
export function ServerAccessCard({
  server,
  onSaved,
}: {
  server: ServerSummary;
  onSaved: () => void;
}) {
  const [serverPw, setServerPw] = useState(server.joinPassword ?? "");
  const [adminPw, setAdminPw] = useState("");
  const [showAdmin, setShowAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const adminMeta = ADMIN_PASSWORD_META[server.game];
  const joinMeta = JOIN_PASSWORD_META[server.game];
  const joinChanged = serverPw !== (server.joinPassword ?? "");
  const adminChanged = adminPw.length > 0;
  const dirty = joinChanged || adminChanged;
  const live = server.state === ServerState.Running || server.state === ServerState.Starting;

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const body: Record<string, string> = {};
      if (joinChanged) body.serverPassword = serverPw; // "" removes it
      if (adminChanged) body.adminPassword = adminPw;
      await apiPatch(`/servers/${server.id}`, body);
      setAdminPw("");
      setSaved(true);
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-ark-accent" />
        <h3 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">
          Access &amp; passwords
        </h3>
      </div>

      {joinMeta.show && (
        <div>
          <label className="label">{joinMeta.label}</label>
          <input
            className="input font-mono"
            placeholder={joinMeta.required ? "" : "Open server — anyone can join"}
            value={serverPw}
            onChange={(e) => {
              setServerPw(e.target.value);
              setSaved(false);
            }}
          />
          <p className="mt-1 text-xs text-slate-500">
            {joinMeta.help
              ? joinMeta.help
              : server.joinPassword
                ? "Players enter this when they join. Clear the box to remove it."
                : "Leave blank for an open server."}
          </p>
        </div>
      )}

      {adminMeta.show && (
        <div>
          <label className="label">{adminMeta.label}</label>
          <div className="relative">
            <input
              type={showAdmin ? "text" : "password"}
              autoComplete="new-password"
              className="input pr-10 font-mono"
              placeholder={server.hasAdminPassword ? "•••••••• set — leave blank to keep" : "Not set"}
              value={adminPw}
              onChange={(e) => {
                setAdminPw(e.target.value);
                setSaved(false);
              }}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-200"
              aria-label={showAdmin ? "Hide what you typed" : "Show what you typed"}
              title={showAdmin ? "Hide" : "Show"}
              onClick={() => setShowAdmin((v) => !v)}
            >
              {showAdmin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {adminMeta.help && `${adminMeta.help} `}Never shown after saving.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={busy || !dirty}>
          {busy ? (
            "Saving…"
          ) : saved ? (
            <>
              <Check className="h-4 w-4" /> Saved
            </>
          ) : (
            <>
              <Save className="h-4 w-4" /> Save
            </>
          )}
        </button>
        {live && dirty && <span className="text-xs text-amber-400">Restart the server to apply.</span>}
      </div>
    </div>
  );
}
