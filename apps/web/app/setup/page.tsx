"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Rocket } from "lucide-react";
import { apiPost, setToken } from "@/lib/api";
import { TimezoneSelect, DEFAULT_TIMEZONE } from "@/components/timezone-select";

export default function SetupPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    username: "",
    password: "",
    timezone: DEFAULT_TIMEZONE,
    curseForgeApiKey: "",
    steamWebApiKey: "",
  });
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username.trim()) return setError("Enter a username.");
    if (form.password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const { token } = await apiPost<{ token: string }>("/auth/first-run", form);
      setToken(token);
      router.replace("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-12 max-w-lg">
      <h1 className="mb-2 text-center text-2xl font-semibold">Welcome — first-run setup</h1>
      <p className="mb-6 text-center text-sm text-slate-400">
        Create your admin account and (optionally) add mod-browser API keys.
      </p>
      <form onSubmit={submit} className="card space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Admin username</label>
            <input className="input" autoComplete="username" value={form.username} onChange={set("username")} />
          </div>
          <div>
            <label className="label">Password (8+ chars)</label>
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              value={form.password}
              onChange={set("password")}
            />
          </div>
          <div>
            <label className="label">Confirm password</label>
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="label">Timezone</label>
          <TimezoneSelect
            value={form.timezone}
            onChange={(tz) => setForm((f) => ({ ...f, timezone: tz }))}
          />
        </div>
        <div>
          <label className="label">CurseForge API key (ASA mods and Minecraft modpacks — optional)</label>
          <input className="input" value={form.curseForgeApiKey} onChange={set("curseForgeApiKey")} />
        </div>
        <div>
          <label className="label">Steam Web API key (ASE mod browser — optional)</label>
          <input className="input" value={form.steamWebApiKey} onChange={set("steamWebApiKey")} />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn-primary w-full justify-center" disabled={busy}>
          <Rocket className="h-4 w-4" /> {busy ? "Setting up…" : "Create & continue"}
        </button>
      </form>
    </div>
  );
}
