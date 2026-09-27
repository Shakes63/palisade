"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, KeyRound, Unlink, UserRound } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { toast } from "@/components/dialogs";

/** Links and unlinks the signed-in user's own SSO account. Only shown once SSO is in play. */
export function AccountMenu() {
  const uid = useId();
  const me = useMe();
  const [sso, setSso] = useState(false);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [unlinked, setUnlinked] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<{ sso?: boolean }>("/auth/status")
      .then((s) => setSso(s.sso === true))
      .catch(() => undefined);
    // Linking round-trips through the provider, and the API's callback lands back on /.
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (hash.get("sso") === "linked") toast.success("SSO account linked. You can now sign in with SSO.");
    else if (hash.get("sso_error")) toast.error(hash.get("sso_error"));
    if (hash.has("sso") || hash.has("sso_error"))
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const linked = me?.sso === true && !unlinked;
  if (!me || (!sso && !linked)) return null;

  const link = async () => {
    setBusy(true);
    try {
      const { url } = await apiPost<{ url: string }>("/auth/oidc/link");
      window.location.href = url;
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  const unlink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiPost("/auth/oidc/unlink", { password });
      toast.success("SSO account unlinked. Sign in with your password from now on.");
      setUnlinked(true);
      setPassword("");
      setOpen(false);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn-secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
        <UserRound className="h-4 w-4" />
        <span className="hidden max-w-[10rem] truncate sm:inline">{me.username}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-md border border-ark-border bg-ark-panel p-3 shadow-xl">
          <p className="text-xs text-slate-400">
            Signed in as <span className="text-slate-200">{me.username}</span>
            {linked ? ", linked to SSO." : "."}
          </p>
          {sso && (
            <button type="button" className="btn-secondary w-full justify-center" onClick={link} disabled={busy}>
              <KeyRound className="h-4 w-4" /> {linked ? "Re-link SSO account" : "Link SSO account"}
            </button>
          )}
          {linked && (
            <form onSubmit={unlink} className="space-y-2 border-t border-ark-border/60 pt-3">
              <label htmlFor={`${uid}-password`} className="label">
                Password, to unlink SSO
              </label>
              <input
                id={`${uid}-password`}
                type="password"
                className="input"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button className="btn-secondary w-full justify-center" disabled={busy || !password}>
                <Unlink className="h-4 w-4" /> Unlink SSO account
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
