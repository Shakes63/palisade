"use client";
import { useEffect, useId, useState } from "react";
import { Import, Loader2 } from "lucide-react";
import { ADMIN_PASSWORD_META, GAME_LABELS, JOIN_PASSWORD_META, type Game } from "@ark/shared";
import { apiGet, apiPost } from "@/lib/api";
import { PasswordFieldHelp, passwordTooShort } from "@/components/password-field-help";
import { keepCase } from "@/lib/keep-case";
import { Loading } from "@/components/loading";

interface Candidate {
  containerId: string;
  containerName: string;
  image: string;
  game: Game;
  running: boolean;
  foreignImage?: string;
  orphaned?: boolean;
  savedName?: string;
  savedPasswords?: { admin?: boolean; join?: boolean };
}

/**
 * Adopt game containers created outside Palisade (e.g. an itzg Minecraft the
 * user already ran from CA). Adoption creates a proper Palisade server and
 * copies the container's world/config data in; the original is stopped and
 * left in place until the user removes it.
 */
export function AdoptContainerPanel({ onDone }: { onDone: () => void }) {
  const uid = useId();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [name, setName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [serverPassword, setServerPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Candidate[]>("/adoption/candidates")
      .then(setCandidates)
      .catch((e) => setErr((e as Error).message));
  }, []);

  const adminMeta = selected ? ADMIN_PASSWORD_META[selected.game] : null;
  const joinMeta = selected ? JOIN_PASSWORD_META[selected.game] : null;
  // A blank password keeps the one the server saved, when that still decrypts.
  const keepsAdmin = selected?.savedPasswords?.admin === true;
  const keepsJoin = selected?.savedPasswords?.join === true;
  const lostPasswords = Object.values(selected?.savedPasswords ?? {}).includes(false);
  const adminTooShort =
    adminMeta && !(keepsAdmin && !adminPassword) ? passwordTooShort(adminMeta, adminPassword) : false;
  const joinTooShort =
    joinMeta && !(keepsJoin && !serverPassword) ? passwordTooShort(joinMeta, serverPassword) : false;
  const invalid = !selected || !name.trim() || adminTooShort || joinTooShort;

  const adopt = async () => {
    if (!selected || invalid) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost("/adoption", {
        containerId: selected.containerId,
        name: name.trim(),
        adminPassword: adminPassword || undefined,
        serverPassword: serverPassword || undefined,
      });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ark-accent2">
        <Import className="h-4 w-4" /> Adopt an existing container
      </h2>
      <p className="text-xs text-slate-500">
        Containers on this host running a game image Palisade knows, but not managed by it. Adopting
        stops the container, creates a Palisade server, and copies its world/config data in. The
        original container is left (stopped) so nothing is lost — remove it yourself once the
        adopted server runs the way you expect. It may need a minute for large worlds. Servers
        Palisade itself created, but lost track of (after a reinstall, say), are listed too and
        reattach where their data already is.
      </p>

      {candidates === null && !err && <Loading label="Scanning containers…" />}
      {candidates?.length === 0 && (
        <p className="text-sm text-slate-400">
          No adoptable containers found. Palisade adopts containers running the image it uses for a
          game, plus the ich777 Palworld and V Rising images it knows how to lift saves out of.
        </p>
      )}

      {candidates?.map((c) => (
        <label
          key={c.containerId}
          className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${
            selected?.containerId === c.containerId ? "border-ark-accent" : "border-slate-700/60"
          }`}
        >
          <input
            type="radio"
            name="adopt-candidate"
            checked={selected?.containerId === c.containerId}
            onChange={() => {
              setSelected(c);
              setName(c.savedName ?? c.containerName);
            }}
          />
          <span className="font-medium text-slate-100">{c.containerName}</span>
          <span className="text-xs text-slate-400">{GAME_LABELS[c.game]}</span>
          {c.foreignImage && (
            <span
              className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] uppercase text-slate-300"
              title={`${c.foreignImage}: Palisade runs a different image for this game, so the saves are copied across and the game files are downloaded fresh.`}
            >
              saves only
            </span>
          )}
          {c.orphaned && (
            <span
              className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] uppercase text-slate-300"
              title="Created by Palisade, but its server is missing from Palisade's database. Adopting reattaches it."
            >
              palisade server
            </span>
          )}
          <span className="ml-auto truncate text-xs text-slate-500">{c.image}</span>
          {c.running && (
            <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">
              running — will be stopped
            </span>
          )}
        </label>
      ))}

      {selected && adminMeta && joinMeta && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-name`} className="label">Server name (required)</label>
            <input id={`${uid}-name`} className="input" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {adminMeta.show && (
            <div>
              <label htmlFor={`${uid}-admin`} className="label">{keepCase(adminMeta.label)}</label>
              <input
                id={`${uid}-admin`}
                type="password"
                className="input"
                placeholder={keepsAdmin ? "Leave blank to keep the saved one" : ""}
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
              <PasswordFieldHelp meta={adminMeta} invalid={adminTooShort} />
            </div>
          )}
          {joinMeta.show && (
            <div>
              <label htmlFor={`${uid}-join`} className="label">{keepCase(joinMeta.label)}</label>
              <input
                id={`${uid}-join`}
                type="password"
                className="input"
                placeholder={
                  keepsJoin
                    ? "Leave blank to keep the saved one"
                    : joinMeta.required
                      ? ""
                      : "Leave blank for an open server"
                }
                value={serverPassword}
                onChange={(e) => setServerPassword(e.target.value)}
              />
              <PasswordFieldHelp meta={joinMeta} invalid={joinTooShort} />
            </div>
          )}
        </div>
      )}
      {selected?.orphaned && (
        <p className="text-xs text-slate-500">
          {!selected.savedName
            ? "Palisade saved no settings for this server, so it comes back with default settings."
            : lostPasswords
              ? "Its settings and mods come back from what Palisade saved on its last start, but the saved passwords can't be read any more, so enter them again."
              : "Its settings, passwords, and mods come back from what Palisade saved on its last start."}{" "}
          Its world and game files stay where they are, and Palisade replaces the old container when
          the server first starts.
        </p>
      )}
      {selected && !selected.orphaned && (
        <p className="text-xs text-slate-500">
          Settings (passwords, map, players) come from what you configure in Palisade — the world
          data is what gets carried over.
          {selected.foreignImage &&
            " This container runs a different image, so its saves are copied into the layout Palisade's image expects and the game files download fresh on first start."}
        </p>
      )}

      {err && <p className="text-sm text-rose-300">{err}</p>}
      {!!candidates?.length && (
        <button type="button" className="btn-primary" onClick={adopt} disabled={invalid || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Import className="h-4 w-4" />}
          {busy ? (selected?.orphaned ? "Adopting…" : "Adopting… (copying data)") : "Adopt container"}
        </button>
      )}
    </div>
  );
}
