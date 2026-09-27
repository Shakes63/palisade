"use client";
import { useEffect, useId, useRef, useState } from "react";
import { KeyRound, LogIn } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiGet, apiPost } from "@/lib/api";

export default function LoginPage() {
  const uid = useId();
  const { login, loginWithSso } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<{ sso: boolean; ssoOnly: boolean } | null>(null);
  // The password form is the way back in whenever SSO fails, and at /login?password.
  const [showPassword, setShowPassword] = useState(false);
  const started = useRef(false);

  const startSso = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await apiPost<{ url: string }>("/auth/oidc/start");
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
      setShowPassword(true);
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const query = new URLSearchParams(window.location.search);
    // The API's SSO callback lands here with #sso=<ticket> or #sso_error=<message>.
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const ticket = hash.get("sso");
    const ssoError = hash.get("sso_error");
    if (ticket || ssoError) window.history.replaceState(null, "", window.location.pathname);
    if (ssoError) setError(ssoError);
    if (ssoError || query.has("password")) setShowPassword(true);

    apiGet<{ sso?: boolean; ssoOnly?: boolean; ssoAutoRedirect?: boolean }>("/auth/status")
      .then((s) => {
        setOptions({ sso: s.sso === true, ssoOnly: s.ssoOnly === true });
        const manual = ticket || ssoError || query.has("password") || query.has("signed_out");
        if (s.ssoAutoRedirect && !manual) void startSso();
      })
      .catch(() => setOptions({ sso: false, ssoOnly: false }));

    if (!ticket) return;
    setBusy(true);
    loginWithSso(ticket)
      .catch((err) => {
        setError((err as Error).message);
        setShowPassword(true);
      })
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!options) return null;
  const passwordForm = !options.ssoOnly || showPassword;

  return (
    <div className="mx-auto mt-20 max-w-sm">
      <h1 className="mb-6 text-center text-2xl font-semibold">Sign in</h1>
      <form onSubmit={submit} className="card space-y-4">
        {passwordForm && (
          <>
            <div>
              <label htmlFor={`${uid}-username`} className="label">Username</label>
              <input
                id={`${uid}-username`}
                className="input"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-password`} className="label">Password</label>
              <input
                id={`${uid}-password`}
                type="password"
                className="input"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {passwordForm && (
          <button className="btn-primary w-full justify-center" disabled={busy}>
            <LogIn className="h-4 w-4" /> {busy ? "Signing in…" : "Sign in"}
          </button>
        )}
        {options.sso && (
          <button
            type="button"
            className={`${passwordForm ? "btn-secondary" : "btn-primary"} w-full justify-center`}
            onClick={startSso}
            disabled={busy}
          >
            <KeyRound className="h-4 w-4" /> Sign in with SSO
          </button>
        )}
      </form>
    </div>
  );
}
