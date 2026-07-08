"use client";
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Plus, X, Loader2 } from "lucide-react";
import { apiGet, apiPut } from "@/lib/api";

type ListKey = "admins" | "whitelist" | "banned";
interface AccessList {
  key: ListKey;
  label: string;
  hint: string;
  entries: string[];
}
interface AccessLists {
  lists: AccessList[];
  applyNote: string;
}

/**
 * Player access lists for the file-managed games (Valheim, Bedrock, 7DTD):
 * admins / whitelist / banned as editable chips. RCON games manage access from
 * the Console instead, so this card isn't shown for them.
 */
export function AccessListsCard({ serverId }: { serverId: string }) {
  const [data, setData] = useState<AccessLists | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<ListKey | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    apiGet<AccessLists>(`/servers/${serverId}/accesslists`)
      .then(setData)
      .catch((e) => setErr((e as Error).message));
  }, [serverId]);
  useEffect(() => refresh(), [refresh]);

  const save = async (key: ListKey, entries: string[]) => {
    setSaving(key);
    setErr(null);
    try {
      setData(await apiPut<AccessLists>(`/servers/${serverId}/accesslists`, { key, entries }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const add = (list: AccessList) => {
    const value = (drafts[list.key] ?? "").trim();
    if (!value) return;
    setDrafts((d) => ({ ...d, [list.key]: "" }));
    void save(list.key, [...list.entries, value]);
  };

  if (!data) return null;

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-ark-accent" />
        <h3 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">
          Players &amp; access
        </h3>
      </div>
      {err && <p className="text-xs text-rose-400">{err}</p>}

      {data.lists.map((list) => (
        <div key={list.key}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-slate-200">
              {list.label}
              {list.entries.length > 0 && (
                <span className="ml-1.5 text-xs font-normal text-slate-500">({list.entries.length})</span>
              )}
            </span>
            {saving === list.key && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {list.entries.map((e) => (
              <span
                key={e}
                className="inline-flex items-center gap-1 rounded-full border border-ark-border bg-ark-bg px-2 py-0.5 font-mono text-xs text-slate-200"
              >
                {e}
                <button
                  className="text-slate-500 hover:text-rose-400"
                  title="Remove"
                  disabled={saving !== null}
                  onClick={() => void save(list.key, list.entries.filter((x) => x !== e))}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                add(list);
              }}
            >
              <input
                className="input h-7 w-48 px-2 py-0 font-mono text-xs"
                placeholder="Add…"
                value={drafts[list.key] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [list.key]: e.target.value }))}
              />
              <button className="btn-secondary h-7 px-2 py-0" disabled={saving !== null}>
                <Plus className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-slate-500">{list.hint}</p>
        </div>
      ))}

      <p className="border-t border-ark-border/50 pt-2 text-[11px] text-slate-500">{data.applyNote}</p>
    </div>
  );
}
