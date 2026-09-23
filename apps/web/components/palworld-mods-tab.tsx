"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Upload, Trash2, Package, ShieldCheck, Loader2, Save, Download, Store, ExternalLink, Settings2, X } from "lucide-react";
import { apiGet, apiPatch, apiPost, apiPut, apiDelete, apiUpload } from "@/lib/api";
import { useRole } from "@/lib/use-role";
import { confirmDialog } from "@/components/dialogs";

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
  palschema?: { installed: boolean; enabled: boolean; mods: string[] };
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
  const uid = useId();
  // Config editing goes through the file-manager endpoints, which are operator-only —
  // the Files tab is hidden from viewers for the same reason, so the gear is too.
  const canEditFiles = useRole() !== "viewer";
  const [status, setStatus] = useState<PalModStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preload, setPreload] = useState("");
  const pakInput = useRef<HTMLInputElement>(null);
  const fwInput = useRef<HTMLInputElement>(null);
  const palschemaFwInput = useRef<HTMLInputElement>(null);
  const palschemaModInput = useRef<HTMLInputElement>(null);
  // PalSchema config editor: which mod is open, its JSON files, and the one being edited.
  const [cfgMod, setCfgMod] = useState<string | null>(null);
  const [cfgFiles, setCfgFiles] = useState<string[]>([]);
  const [cfgPath, setCfgPath] = useState<string | null>(null);
  const [cfgText, setCfgText] = useState("");
  const [cfgSaved, setCfgSaved] = useState("");
  const [cfgBusy, setCfgBusy] = useState(false);
  // Errors while loading or saving a config file show INSIDE the modal — the page-level
  // `err` banner renders behind it at z-50, so a load failure would otherwise be invisible.
  const [cfgErr, setCfgErr] = useState<string | null>(null);

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

  /**
   * Config editing rides on the file-manager endpoints rather than palmods routes of
   * its own: the API hands back instance-root-relative paths, which is exactly what
   * /files/content reads and writes. Only the listing needs a PalSchema-aware route,
   * because a mod nests its JSON several levels deep (translations/<lang>/...).
   */
  const cfgDirty = cfgText !== cfgSaved;

  const loadCfgFile = async (path: string) => {
    setCfgBusy(true);
    setCfgErr(null);
    try {
      const r = await apiGet<{ content: string }>(
        `/servers/${serverId}/files/content?path=${encodeURIComponent(path)}`,
      );
      setCfgPath(path);
      setCfgText(r.content);
      setCfgSaved(r.content);
    } catch (e) {
      // Leave cfgPath as-is (null on first open) and surface the reason in the modal,
      // e.g. the file-manager read cap on a large raw/ dump.
      setCfgErr((e as Error).message);
    } finally {
      setCfgBusy(false);
    }
  };

  const openCfg = async (mod: string) => {
    setCfgBusy(true);
    setCfgErr(null);
    setErr(null);
    try {
      const { files } = await apiGet<{ files: string[] }>(
        `/servers/${serverId}/palmods/palschema/mods/${encodeURIComponent(mod)}/config`,
      );
      setCfgMod(mod);
      setCfgFiles(files);
      setCfgPath(null);
      setCfgText("");
      setCfgSaved("");
      if (files.length === 0) setCfgErr(`${mod} has no editable .json/.jsonc files.`);
      else await loadCfgFile(files[0]!);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCfgBusy(false);
    }
  };

  const saveCfg = async () => {
    if (!cfgPath) return;
    setCfgBusy(true);
    setCfgErr(null);
    try {
      await apiPut(`/servers/${serverId}/files/content`, { path: cfgPath, content: cfgText });
      setCfgSaved(cfgText);
    } catch (e) {
      setCfgErr((e as Error).message);
    } finally {
      setCfgBusy(false);
    }
  };

  // Returns whether the editor actually closed — false when the user backed out of the
  // "Discard unsaved changes?" prompt. Callers that do something destructive on close
  // (e.g. deleting the mod) must gate on this; the Escape handler can ignore it.
  const closeCfg = async (): Promise<boolean> => {
    if (cfgDirty && !(await confirmDialog({ title: "Discard unsaved changes?", confirmLabel: "Discard", danger: true }))) return false;
    setCfgMod(null);
    setCfgPath(null);
    setCfgText("");
    setCfgSaved("");
    setCfgErr(null);
    return true;
  };

  // Escape closes the editor, like ModDetailModal — routed through closeCfg so an
  // unsaved edit still prompts. No dep array: closeCfg is rebuilt every render and
  // closes over cfgDirty, so the listener has to be rebuilt with it.
  useEffect(() => {
    if (!cfgMod) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void closeCfg();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const fw = status?.framework;
  const wine = Boolean(fw?.wine);

  return (
    <div className="space-y-4">
      {err && <div className="card border-rose-500/40 text-sm text-rose-300">{err}</div>}

      {status && !wine && (
        <p className="rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs leading-snug text-amber-200/90">
          This server is the native-Linux variant: it loads pak mods and Lua/Blueprint mods through the
          experimental UE4SS Linux fork. DLL server mods such as PalDefender and PalGuard need the{" "}
          <span className="font-semibold">Palworld (Wine)</span> variant.
        </p>
      )}

      {/* ── Server mods (curated links) ─────────────────────────────────── */}
      {wine && (
        <div className="card space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            <Store className="h-4 w-4" /> Server mods
          </h3>
          <p className="text-[11px] leading-snug text-slate-500">
            Palworld has no in-app mod store (it isn&apos;t on Steam Workshop, and Nexus gates automated
            downloads), so here are the established dedicated-server mods. These are{" "}
            <span className="font-semibold text-slate-300">UE4SS DLL mods</span> — install the UE4SS
            framework below, download the mod from its page, then follow the mod&apos;s install steps.
          </p>
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
      )}

      {/* ── Pak content mods ────────────────────────────────────────────── */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            <Package className="h-4 w-4" /> Pak mods
          </h3>
          <button
            className="btn-secondary shrink-0 whitespace-nowrap"
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
                  className="btn-remove"
                  title="Remove"
                  aria-label={`Remove ${p}`}
                  disabled={busy}
                  onClick={async () => {
                    if (!(await confirmDialog({ title: `Remove ${p} from this server?`, confirmLabel: "Remove", danger: true })))
                      return;
                    void run(() => apiDelete(`/servers/${serverId}/palmods/paks?path=${encodeURIComponent(p)}`));
                  }}
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
            <span className="font-mono">Pal/Content/Paks/~mods</span>. A zip that ships its own mod
            folder keeps it; the files inside are listed here either way.
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

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={fw?.present ? "text-ark-accent" : "text-amber-400"}>
            {fw?.present ? "● framework installed" : "○ framework not installed"}
          </span>
          <button
            className="btn-secondary whitespace-nowrap"
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
            <label htmlFor={`${uid}-preload`} className="label">Preload library (relative to the install dir)</label>
            <div className="flex gap-2">
              <input
                id={`${uid}-preload`}
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
            <span className="font-mono">Pal/Binaries/Win64/Mods</span>; mods that ship their own proxy
            loader (PalDefender&apos;s <span className="font-mono">d3d9.dll</span>) go next to the server
            exe in <span className="font-mono">Win64</span> and are detected on start. Restart to apply.{" "}
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

      {/* ── PalSchema (JSON content mod loader) ─────────────────────────── */}
      {wine && (
        <div className="card space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
            <ShieldCheck className="h-4 w-4" /> PalSchema
          </h3>
          <p className="text-[11px] leading-snug text-slate-500">
            A UE4SS logic mod that lets JSON-based content mods (new Pals, items, recipes) load
            without writing a Blueprint mod. It runs through UE4SS — install that above first.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-primary"
              disabled={busy || !fw?.present}
              title={fw?.present ? undefined : "Install the UE4SS framework above first"}
              onClick={() => run(() => apiPost(`/servers/${serverId}/palmods/framework/install-palschema`))}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Install PalSchema
            </button>
            <span className={status?.palschema?.installed ? "text-ark-accent text-xs" : "text-amber-400 text-xs"}>
              {status?.palschema?.installed ? "● installed" : "○ not installed"}
            </span>
            <button
              className="btn-secondary"
              disabled={busy || !fw?.present}
              title={fw?.present ? undefined : "Install the UE4SS framework above first"}
              onClick={() => palschemaFwInput.current?.click()}
            >
              <Upload className="h-4 w-4" /> Upload PalSchema .zip
            </button>
            <input
              ref={palschemaFwInput}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) run(() => apiUpload(`/servers/${serverId}/palmods/framework/palschema/upload`, f));
                e.target.value = "";
              }}
            />
          </div>
          {!fw?.present && (
            <p className="rounded border border-amber-500/40 bg-amber-950/30 px-2 py-1.5 text-[11px] leading-snug text-amber-300">
              Install the UE4SS framework above first — PalSchema loads through it.
            </p>
          )}
          {status?.palschema?.installed && !status.palschema.enabled && (
            <p className="rounded border border-amber-500/40 bg-amber-950/30 px-2 py-1.5 text-[11px] leading-snug text-amber-300">
              PalSchema is on disk but has no <span className="font-mono">enabled.txt</span>, so UE4SS
              won&apos;t start it. Re-run the install above to add the marker.
            </p>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Content mods</h4>
            <button
              className="btn-secondary"
              disabled={busy || !fw?.present || !status?.palschema?.installed}
              title={
                !fw?.present
                  ? "Install the UE4SS framework above first"
                  : status?.palschema?.installed
                    ? undefined
                    : "Install PalSchema first"
              }
              onClick={() => palschemaModInput.current?.click()}
            >
              <Upload className="h-4 w-4" /> Upload mod .zip
            </button>
            <input
              ref={palschemaModInput}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) run(() => apiUpload(`/servers/${serverId}/palmods/palschema/mods`, f));
                e.target.value = "";
              }}
            />
          </div>
          {status?.palschema && status.palschema.mods.length > 0 ? (
            <ul className="divide-y divide-ark-border/50 text-sm">
              {status.palschema.mods.map((m) => (
                <li key={m} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="truncate font-mono text-slate-200">{m}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {canEditFiles && (
                    <button
                      className={
                        cfgMod === m
                          ? "text-ark-accent2"
                          : "text-slate-500 hover:text-ark-accent2"
                      }
                      title="Edit this mod's JSON config"
                      aria-label={`Edit ${m} config`}
                      disabled={busy || cfgBusy}
                      onClick={() => void (cfgMod === m ? closeCfg() : openCfg(m))}
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                    )}
                    <button
                      className="btn-remove"
                      title="Remove"
                      aria-label={`Remove ${m}`}
                      disabled={busy}
                      onClick={async () => {
                        // If this mod's editor is open, closeCfg() may prompt about unsaved
                        // edits — respect a cancel and DON'T delete out from under it.
                        if (cfgMod === m && !(await closeCfg())) return;
                        if (!(await confirmDialog({ title: `Remove ${m} from this server?`, confirmLabel: "Remove", danger: true })))
                          return;
                        void run(() => apiDelete(`/servers/${serverId}/palmods/palschema/mods/${encodeURIComponent(m)}`));
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">
              No PalSchema mods yet. Upload a mod&apos;s <span className="font-mono">.zip</span> — its folder
              goes into <span className="font-mono">Mods/PalSchema/mods</span>.
            </p>
          )}
          <p className="text-[11px] text-slate-500">Restart the server to load mod changes.</p>
        </div>
      )}

      {/* ── Config editor ──────────────────────────────────────────────────
          A modal rather than an inline panel: the PalSchema card sits near the
          bottom of a long tab, so expanding in place left the editor below the
          fold and the page jumped mid-document on open. Same overlay shape as
          ModDetailModal. */}
      {cfgMod && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
          onClick={closeCfg}
        >
          <div className="card my-4 w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-lg font-semibold">
                  {cfgMod}
                  {cfgDirty ? " •" : ""}
                </h3>
                <p className="truncate font-mono text-[11px] text-slate-500">{cfgPath ?? ""}</p>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                <button
                  className="btn-primary text-xs"
                  disabled={cfgBusy || !cfgDirty || !cfgPath}
                  onClick={() => void saveCfg()}
                >
                  {cfgBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
                </button>
                <button className="btn-secondary px-2" onClick={closeCfg} title="Close" aria-label="Close">
                  <X className="h-4 w-4" />
                </button>
              </span>
            </div>

            {/* One file is the common case; a mod with translations has a dozen. */}
            {cfgFiles.length > 1 && (
              <select
                className="mb-2 w-full rounded-md border border-ark-border bg-ark-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-ark-accent2 focus:ring-2 focus:ring-ark-accent2/50"
                value={cfgPath ?? ""}
                disabled={cfgBusy}
                onChange={async (e) => {
                  const next = e.target.value;
                  if (cfgDirty && !(await confirmDialog({ title: "Discard unsaved changes?", confirmLabel: "Discard", danger: true }))) return;
                  void loadCfgFile(next);
                }}
              >
                {cfgFiles.map((f) => (
                  <option key={f} value={f}>
                    {f.split(`mods/${cfgMod}/`)[1] ?? f}
                  </option>
                ))}
              </select>
            )}

            {cfgErr && (
              <p className="mb-2 rounded border border-rose-500/40 bg-rose-950/30 px-2 py-1.5 text-[11px] leading-snug text-rose-300">
                {cfgErr}
              </p>
            )}

            {cfgPath ? (
              <textarea
                className="h-[60vh] w-full resize-y rounded-lg border border-ark-border bg-ark-bg p-3 font-mono text-xs leading-relaxed outline-none focus:border-ark-accent2 focus:ring-2 focus:ring-ark-accent2/50"
                value={cfgText}
                onChange={(e) => setCfgText(e.target.value)}
                spellCheck={false}
              />
            ) : (
              !cfgErr && <p className="py-6 text-xs text-slate-500">No editable .json/.jsonc files in this mod.</p>
            )}
            <p className="mt-2 text-[11px] text-slate-500">
              Saved straight to the mod folder. Restart the server to apply. These are{" "}
              <span className="font-mono">.jsonc</span> files — comments and trailing commas are
              allowed, so this is not validated as strict JSON.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
