"use client";
import { useEffect, useRef, useState } from "react";
import { Upload, Trash2, Package, ShieldCheck, Loader2, Save, Download, Store, ExternalLink } from "lucide-react";
import { apiGet, apiPatch, apiPost, apiDelete, apiUpload } from "@/lib/api";

/**
 * Curated list of the established Palworld DEDICATED-SERVER mods. Palworld isn't on
 * Steam Workshop and its main mod hub (Nexus) gates automated downloads, so there's no
 * one-click browser — instead we point at the handful of real server mods. These are
 * UE4SS DLL mods: they run on the Wine variant. Links verified 2026-07-11.
 */
const CURATED_SERVER_MODS: { name: string; desc: string; url: string; host: string }[] = [
  {
    name: "PalDefender",
    desc: "Server-side anti-cheat with pre-execution validation that warns, kicks, or bans cheaters. Actively maintained; releases on GitHub.",
    url: "https://github.com/Ultimeit/PalDefender/releases",
    host: "GitHub",
  },
];

type PalModStatus = {
  paks: string[];
  framework: { enabled: boolean; preload: string; present: boolean; wine: boolean };
};

/** The only known native-Linux UE4SS build. Official UE4SS releases are Windows-only
 *  (a dwmapi.dll proxy), so users hunting for a libUE4SS.so on the official repo come
 *  up empty — link them straight at the experimental Linux fork instead. */
const UE4SS_LINUX_RELEASE = "https://github.com/Yangff/RE-UE4SS/releases/tag/linux-experiment";
/** The official UE4SS Windows build — used by the Wine variant, where it loads DLL mods. */
const UE4SS_WINDOWS_RELEASE = "https://github.com/UE4SS-RE/RE-UE4SS/releases/tag/v3.0.1";

/**
 * Palworld mod management (it's not on Steam Workshop): upload .pak content mods into
 * the bind-mounted Pal/Content/Paks/~mods, plus a server-side framework (UE4SS).
 * Both take effect on the next restart.
 *
 * The framework story differs by variant, driven by the `wine` flag on the status:
 *  - Native Linux: the experimental libUE4SS.so in Pal/Binaries/Linux, toggled and
 *    loaded via LD_PRELOAD. Only Lua/Blueprint mods work.
 *  - Wine: the official UE4SS Windows build in Pal/Binaries/Win64, auto-loaded by the
 *    dwmapi.dll proxy (no toggle, no LD_PRELOAD). DLL mods (PalGuard, PalDefender) work.
 */
export function PalworldModsTab({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<PalModStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preload, setPreload] = useState("");
  const pakInput = useRef<HTMLInputElement>(null);
  const fwInput = useRef<HTMLInputElement>(null);

  const apply = (s: PalModStatus) => {
    setStatus(s);
    setPreload(s.framework.preload);
  };
  useEffect(() => {
    apiGet<PalModStatus>(`/servers/${serverId}/palmods`).then(apply).catch((e) => setErr(e.message));
  }, [serverId]);

  const run = async (fn: () => Promise<PalModStatus>) => {
    setBusy(true);
    setErr(null);
    try {
      apply(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fw = status?.framework;
  const wine = Boolean(fw?.wine);

  return (
    <div className="space-y-4">
      {err && <div className="card border-rose-500/40 text-sm text-rose-300">{err}</div>}

      {/* ── Popular server mods (curated links) ─────────────────────────── */}
      <div className="card space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
          <Store className="h-4 w-4" /> Popular server mods
        </h3>
        <p className="text-[11px] leading-snug text-slate-500">
          Palworld has no in-app mod store (it isn&apos;t on Steam Workshop, and Nexus gates automated
          downloads), so here are the established dedicated-server mods. These are{" "}
          <span className="font-semibold text-slate-300">UE4SS DLL mods</span> — install the UE4SS
          framework below, download the mod from its page, then follow the mod&apos;s install steps.
        </p>
        {!wine && (
          <p className="rounded-md border border-amber-900/40 bg-amber-950/20 px-2.5 py-1.5 text-[11px] leading-snug text-amber-200/90">
            These DLL mods need the <span className="font-semibold">Palworld (Wine)</span> variant. This
            server is the native-Linux variant, which only runs Lua/Blueprint mods via the experimental
            UE4SS Linux fork.
          </p>
        )}
        <ul className="divide-y divide-ark-border/50">
          {CURATED_SERVER_MODS.map((m) => (
            <li key={m.name} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <span className="text-sm font-medium text-slate-100">{m.name}</span>
                <span className="ml-2 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-300">
                  {m.host}
                </span>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{m.desc}</p>
              </div>
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary shrink-0"
                title={`Open ${m.name} on ${m.host}`}
              >
                Open <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </li>
          ))}
        </ul>
        <p className="text-[11px] leading-snug text-slate-500">
          <span className="font-medium text-slate-400">PalGuard</span> (another popular anti-cheat) is
          intentionally not linked here: it has no public Nexus/GitHub download page and is distributed
          only through its community Discord, so there&apos;s no stable link to point at. Search
          &ldquo;PalGuard Palworld&rdquo; to find its current Discord if you want it.
        </p>
      </div>

      {/* ── Pak content mods ────────────────────────────────────────────── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            <Package className="h-4 w-4" /> Pak mods
          </h3>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => pakInput.current?.click()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload .pak
          </button>
          <input
            ref={pakInput}
            type="file"
            accept=".pak,.ucas,.utoc,.zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) run(() => apiUpload(`/servers/${serverId}/palmods/paks`, f));
              e.target.value = "";
            }}
          />
        </div>
        {status && status.paks.length > 0 ? (
          <ul className="divide-y divide-ark-border/50 text-sm">
            {status.paks.map((p) => (
              <li key={p} className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate font-mono text-slate-200">{p}</span>
                <button
                  className="shrink-0 text-slate-500 hover:text-rose-400"
                  title="Remove"
                  disabled={busy}
                  onClick={() => run(() => apiDelete(`/servers/${serverId}/palmods/paks/${encodeURIComponent(p)}`))}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">
            No pak mods yet. Upload <span className="font-mono">.pak</span> /{" "}
            <span className="font-mono">.ucas</span> / <span className="font-mono">.utoc</span> files (or a{" "}
            <span className="font-mono">.zip</span> of them) — they go into{" "}
            <span className="font-mono">Pal/Content/Paks/~mods</span>.
          </p>
        )}
        <p className="text-[11px] text-slate-500">Restart the server to load mod changes.</p>
      </div>

      {/* ── Server mod framework (UE4SS) ────────────────────────────────── */}
      <div className="card space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
          <ShieldCheck className="h-4 w-4" /> Server mod framework (UE4SS)
        </h3>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() => run(() => apiPost(`/servers/${serverId}/palmods/framework/install-ue4ss`))}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {wine ? "Install UE4SS (Windows)" : "Install UE4SS (Linux)"}
          </button>
          <span className="text-[11px] text-slate-500">
            Downloads + verifies the build, extracts it, and enables the framework.
          </span>
        </div>

        {wine ? (
          <p className="text-[11px] leading-snug text-slate-500">
            Installs the official{" "}
            <a
              href={UE4SS_WINDOWS_RELEASE}
              target="_blank"
              rel="noreferrer"
              className="text-ark-accent hover:underline"
            >
              UE4SS Windows build
            </a>{" "}
            into <span className="font-mono">Pal/Binaries/Win64</span>, where Wine auto-loads it via
            the <span className="font-mono">dwmapi.dll</span> proxy. Prefer a different build? Upload
            its .zip below instead.
          </p>
        ) : (
          <p className="text-[11px] leading-snug text-slate-500">
            Official UE4SS builds are Windows-only, so there is no{" "}
            <span className="font-mono">libUE4SS.so</span> on the UE4SS releases page. The button above
            installs the experimental{" "}
            <a
              href={UE4SS_LINUX_RELEASE}
              target="_blank"
              rel="noreferrer"
              className="text-ark-accent hover:underline"
            >
              native Linux build
            </a>
            . Prefer a different build? Upload its .zip below instead.
          </p>
        )}

        {/* Native gates loading behind an LD_PRELOAD flag; Wine's proxy auto-loads when
            present, so there's nothing to toggle. */}
        {!wine && (
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={Boolean(fw?.enabled)}
              disabled={busy}
              onChange={(e) => run(() => apiPatch(`/servers/${serverId}/palmods/framework`, { enabled: e.target.checked }))}
            />
            Enable framework (loaded via <span className="font-mono">LD_PRELOAD</span> on start)
          </label>
        )}

        <div className="flex items-center gap-2 text-xs">
          <span className={fw?.present ? "text-ark-accent" : "text-amber-400"}>
            {fw?.present ? "● framework installed" : "○ framework not installed"}
          </span>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => fwInput.current?.click()}
          >
            <Upload className="h-4 w-4" /> Upload framework .zip
          </button>
          <input
            ref={fwInput}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) run(() => apiUpload(`/servers/${serverId}/palmods/framework/upload`, f));
              e.target.value = "";
            }}
          />
        </div>

        {!wine && (
          <div>
            <label className="label">Preload library (relative to the install dir)</label>
            <div className="flex gap-2">
              <input
                className="input font-mono"
                value={preload}
                onChange={(e) => setPreload(e.target.value)}
                placeholder="Pal/Binaries/Linux/libUE4SS.so"
              />
              <button
                className="btn-secondary"
                disabled={busy || preload === fw?.preload}
                onClick={() => run(() => apiPatch(`/servers/${serverId}/palmods/framework`, { preload }))}
              >
                <Save className="h-4 w-4" /> Save
              </button>
            </div>
          </div>
        )}

        {!wine && fw?.enabled && !fw.present && (
          <p className="rounded border border-amber-500/40 bg-amber-950/30 px-2 py-1.5 text-[11px] leading-snug text-amber-300">
            The framework is enabled but <span className="font-mono">{fw.preload}</span> isn&apos;t on
            disk. The server will start without it — upload the framework .zip, or the preload path
            doesn&apos;t match what the archive contained.
          </p>
        )}

        {wine ? (
          <p className="text-[11px] leading-snug text-slate-500">
            This server runs the <span className="text-slate-300">Windows</span> Palworld binary under
            Wine; UE4SS lives in <span className="font-mono">Pal/Binaries/Win64</span> and auto-loads via
            the <span className="font-mono">dwmapi.dll</span> proxy — no LD_PRELOAD. Drop DLL mods into{" "}
            <span className="font-mono">Pal/Binaries/Win64/Mods</span>. Restart to apply.{" "}
            <span className="text-slate-400">
              Lua, Blueprint <em>and</em> DLL mods (PalGuard, PalDefender) all work here.
            </span>
          </p>
        ) : (
          <p className="text-[11px] leading-snug text-slate-500">
            This server runs the <span className="text-slate-300">native Linux</span> Palworld binary, so the
            framework must be a Linux build; its files are extracted into{" "}
            <span className="font-mono">Pal/Binaries/Linux</span> and injected via{" "}
            <span className="font-mono">LD_PRELOAD</span>. Restart the server to apply.{" "}
            <span className="text-slate-400">
              Lua and Blueprint mods work; DLL-based mods (PalGuard, PalDefender) cannot load into a
              Linux process and need the Windows server under Wine.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
