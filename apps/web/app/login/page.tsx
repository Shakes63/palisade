"use client";
import { useId, useState } from "react";
import { LogIn } from "lucide-react";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const uid = useId();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="mx-auto mt-20 max-w-sm">
      <h1 className="mb-6 text-center text-2xl font-semibold">Sign in</h1>
      <form onSubmit={submit} className="card space-y-4">
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
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn-primary w-full justify-center" disabled={busy}>
          <LogIn className="h-4 w-4" /> {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
