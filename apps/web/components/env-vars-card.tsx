"use client";
import { useState } from "react";
import { Terminal, Plus, Trash2, Save, Check, ChevronDown } from "lucide-react";
import type { ServerSummary, EnvVar } from "@ark/shared";
import { apiPatch } from "@/lib/api";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Advanced card for managing custom environment variables that are injected into the
 * game container at start time (appended last, so they can override any built-in
 * variable set by the manager — e.g. TARGET_MANIFEST_ID for Palworld).
 */
export function EnvVarsCard({ server, onSaved }: { server: ServerSummary; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EnvVar[]>(() =>
    Array.isArray(server.extraEnv) ? server.extraEnv.map((e) => ({ ...e })) : [],
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-sync local state when the server prop changes (e.g. after a refresh).
  const [lastId, setLastId] = useState(server.id);
  if (server.id !== lastId) {
    setLastId(server.id);
    setRows(Array.isArray(server.extraEnv) ? server.extraEnv.map((e) => ({ ...e })) : []);
  }

  const dirty =
    JSON.stringify(rows) !== JSON.stringify(Array.isArray(server.extraEnv) ? server.extraEnv : []);

  const addRow = () => setRows((r) => [...r, { key: "", value: "" }]);

  const removeRow = (i: number) =>
    setRows((r) => r.filter((_, idx) => idx !== i));

  const setKey = (i: number, key: string) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, key } : row)));

  const setValue = (i: number, value: string) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, value } : row)));

  const keyError = (key: string) =>
    key.length > 0 && !KEY_RE.test(key) ? "Invalid name" : null;

  const hasDuplicateKey = (i: number) => {
    const k = rows[i].key;
    return k.length > 0 && rows.some((r, idx) => idx !== i && r.key === k);
  };

  const canSave =
    dirty &&
    rows.every((r) => KEY_RE.test(r.key)) &&
    rows.every((_, i) => !hasDuplicateKey(i));

  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await apiPatch(`/servers/${server.id}`, { extraEnv: rows });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const count = server.extraEnv?.length ?? 0;

  return (
    <div className="card">
      <button
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
          <Terminal className="h-4 w-4" /> Custom env vars
          {count > 0 && (
            <span className="ml-1 rounded bg-slate-700/60 px-1.5 py-0.5 font-mono text-[11px] font-normal normal-case text-slate-300">
              {count} set
            </span>
          )}
        </span>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] leading-snug text-slate-500">
            These environment variables are appended to the container at start — they can override
            any built-in variable set by the manager (e.g.{" "}
            <span className="font-mono text-slate-400">TARGET_MANIFEST_ID</span> for Palworld version
            pinning). A server restart is required after saving.
          </p>

          {rows.length > 0 && (
            <div className="space-y-2">
              {rows.map((row, i) => {
                const ke = keyError(row.key);
                const dup = hasDuplicateKey(i);
                return (
                  <div key={i} className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <input
                        className={`input font-mono text-xs ${ke || dup ? "border-rose-500/60" : ""}`}
                        placeholder="VARIABLE_NAME"
                        value={row.key}
                        onChange={(e) => setKey(i, e.target.value)}
                        spellCheck={false}
                        autoCapitalize="characters"
                      />
                      {ke && <p className="mt-0.5 text-[10px] text-rose-400">{ke}</p>}
                      {dup && <p className="mt-0.5 text-[10px] text-rose-400">Duplicate key</p>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <input
                        className="input font-mono text-xs"
                        placeholder="value"
                        value={row.value}
                        onChange={(e) => setValue(i, e.target.value)}
                        spellCheck={false}
                      />
                    </div>
                    <button
                      className="mt-1 text-slate-500 hover:text-rose-400 transition-colors"
                      onClick={() => removeRow(i)}
                      title="Remove"
                      type="button"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {rows.length === 0 && (
            <p className="text-xs text-slate-600 italic">No custom env vars configured.</p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              className="btn-secondary inline-flex items-center gap-1.5 text-xs"
              onClick={addRow}
              type="button"
            >
              <Plus className="h-3.5 w-3.5" /> Add variable
            </button>
            <button
              className="btn-primary inline-flex items-center gap-1.5 text-xs"
              disabled={!canSave || busy}
              onClick={() => void save()}
              type="button"
            >
              {busy ? null : saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              {busy ? "Saving…" : saved ? "Saved" : "Save"}
            </button>
          </div>

          {err && <p className="text-xs text-rose-400">{err}</p>}
        </div>
      )}
    </div>
  );
}
