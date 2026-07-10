"use client";
import { useEffect, useState } from "react";
import { Save, KeyRound, Send, CheckCircle2, Circle } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { TimezoneSelect, detectZone } from "@/components/timezone-select";
import { NotificationTargetsCard } from "@/components/notification-targets";

type SettingsView = Record<string, string | boolean>;

export default function SettingsPage() {
  const [view, setView] = useState<SettingsView>({});
  const [timezone, setTimezone] = useState("");
  const [curseForgeApiKey, setCurseForgeApiKey] = useState("");
  const [steamWebApiKey, setSteamWebApiKey] = useState("");
  const [backupKeep, setBackupKeep] = useState("10");
  const [autoStop, setAutoStop] = useState(true);
  const [pfsenseHost, setPfsenseHost] = useState("");
  const [pfsenseApiKey, setPfsenseApiKey] = useState("");
  const [pfsenseTargetIp, setPfsenseTargetIp] = useState("");
  const [pfTestMsg, setPfTestMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    apiGet<SettingsView>("/settings")
      .then((v) => {
        setView(v);
        // Pre-select the user's detected zone when nothing is saved yet, so they
        // rarely have to touch it.
        setTimezone(typeof v.timezone === "string" && v.timezone ? v.timezone : detectZone());
        if (typeof v.backup_keep === "string" && v.backup_keep) setBackupKeep(v.backup_keep);
        setAutoStop(v.auto_stop_on_start !== "false"); // default on when unset
        if (typeof v.pfsense_host === "string") setPfsenseHost(v.pfsense_host);
        if (typeof v.pfsense_target_ip === "string") setPfsenseTargetIp(v.pfsense_target_ip);
      })
      .catch(() => undefined);
  };
  useEffect(load, []);

  const configured = (key: string) => view[key] === true || typeof view[key] === "string";

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const settingsBody: Record<string, string | number | boolean> = {};
      if (timezone) settingsBody.timezone = timezone;
      if (curseForgeApiKey) settingsBody.curseForgeApiKey = curseForgeApiKey;
      if (steamWebApiKey) settingsBody.steamWebApiKey = steamWebApiKey;
      const keep = parseInt(backupKeep, 10);
      if (Number.isFinite(keep) && keep >= 1) settingsBody.backupKeep = keep;
      settingsBody.autoStopOnStart = autoStop;
      settingsBody.pfsenseHost = pfsenseHost;
      settingsBody.pfsenseTargetIp = pfsenseTargetIp;
      if (pfsenseApiKey) settingsBody.pfsenseApiKey = pfsenseApiKey;
      if (Object.keys(settingsBody).length) await apiPatch("/settings", settingsBody);
      setCurseForgeApiKey("");
      setSteamWebApiKey("");
      setPfsenseApiKey("");
      setSaved(true);
      load();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Tests the SAVED settings — remind the user to hit Save first if fields are dirty.
  const testPfsense = async () => {
    setPfTestMsg("Testing…");
    try {
      const res = await apiPost<{ ok: boolean; message: string }>("/pfsense/test");
      setPfTestMsg(`${res.ok ? "✓ " : "✗ "}${res.message}`);
    } catch (err) {
      setPfTestMsg((err as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <KeyRound className="h-5 w-5 text-ark-accent" /> Settings
      </h1>

      <div className="card space-y-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">
          Mod browser API keys
        </h2>

        <SecretField
          label="CurseForge API key (ASA mod browser)"
          value={curseForgeApiKey}
          onChange={setCurseForgeApiKey}
          configured={configured("curseforge_api_key")}
        />
        <SecretField
          label="Steam Web API key (ASE Workshop browser)"
          value={steamWebApiKey}
          onChange={setSteamWebApiKey}
          configured={configured("steam_web_api_key")}
        />
      </div>

      <NotificationTargetsCard />

      <div className="card space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">
          pfSense port forwarding
        </h2>
        <p className="text-xs text-slate-500">
          With these set, each server&apos;s Overview gets one-click WAN port-forward management. Requires
          the free{" "}
          <a
            href="https://pfrest.org/"
            target="_blank"
            rel="noreferrer"
            className="text-ark-accent hover:underline"
          >
            pfSense REST API package
          </a>{" "}
          on your router (System → REST API → generate an API key). Works with any pfSense — nothing is
          tied to a specific network.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">pfSense host / IP</label>
            <input
              className="input"
              placeholder="e.g. 192.168.1.1 (your router)"
              value={pfsenseHost}
              onChange={(e) => setPfsenseHost(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Forward to (this machine&apos;s LAN IP)</label>
            <input
              className="input"
              placeholder="e.g. 192.168.1.50 (this server box)"
              value={pfsenseTargetIp}
              onChange={(e) => setPfsenseTargetIp(e.target.value)}
            />
          </div>
        </div>
        <SecretField
          label="pfSense REST API key"
          value={pfsenseApiKey}
          onChange={setPfsenseApiKey}
          configured={configured("pfsense_api_key")}
        />
        <div>
          <button type="button" className="btn-secondary" onClick={testPfsense}>
            <Send className="h-4 w-4" /> Test connection
          </button>
          {pfTestMsg && <p className="mt-2 text-sm text-slate-400">{pfTestMsg}</p>}
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">Backups</h2>
        <div>
          <label className="label">Keep last N backups (per server)</label>
          <input
            type="number"
            min={1}
            max={500}
            className="input w-32"
            value={backupKeep}
            onChange={(e) => setBackupKeep(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">
            Older snapshots beyond this count are deleted automatically. Default 10. Each backup is
            just the live world, players, and config (ARK&apos;s own dated copies + logs are skipped).
          </p>
        </div>
      </div>

      <div className="card space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">Start guard</h2>
        <label className="flex items-start gap-3 text-sm text-slate-200">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={autoStop}
            onChange={(e) => setAutoStop(e.target.checked)}
          />
          <span>
            Auto-stop a running server to free RAM
            <span className="mt-1 block text-xs font-normal text-slate-500">
              When starting a server would exceed free memory, offer to back up and shut down a running one,
              then start the new one. You still confirm first — with a single running server it&apos;s a quick
              warning. Off: a start that won&apos;t fit is just blocked with a warning.
            </span>
          </span>
        </label>
      </div>

      <div className="card space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">General</h2>
        <div>
          <label className="label">Timezone (scheduler)</label>
          <TimezoneSelect value={timezone} onChange={setTimezone} />
          <p className="mt-1 text-xs text-slate-500">
            Used for schedule times. Defaults to this device&apos;s timezone.
          </p>
        </div>
      </div>

      <button className="btn-primary" onClick={save} disabled={busy}>
        <Save className="h-4 w-4" /> {busy ? "Saving…" : saved ? "Saved ✓" : "Save settings"}
      </button>

      <CreditsCard />
    </div>
  );
}

/** The community images doing the actual heavy lifting — one server at a time. */
const IMAGE_CREDITS: { game: string; maintainer: string; url: string }[] = [
  { game: "ARK: Survival Ascended", maintainer: "Acekorneya (POK)", url: "https://github.com/Acekorneya/Ark-Survival-Ascended-Server" },
  { game: "Conan Exiles", maintainer: "Acekorneya (POK)", url: "https://github.com/Acekorneya/POK_Conan_Enhanced_Docker_server" },
  { game: "ARK: Survival Evolved", maintainer: "Hermsi1337", url: "https://github.com/Hermsi1337/docker-ark-server" },
  { game: "Palworld", maintainer: "Thijs van Loef", url: "https://github.com/thijsvanloef/palworld-server-docker" },
  { game: "Minecraft (Java)", maintainer: "itzg", url: "https://github.com/itzg/docker-minecraft-server" },
  { game: "Minecraft Bedrock", maintainer: "itzg", url: "https://github.com/itzg/docker-minecraft-bedrock-server" },
  { game: "Icarus", maintainer: "mornedhels", url: "https://github.com/mornedhels/icarus-server" },
  { game: "Enshrouded", maintainer: "mornedhels", url: "https://github.com/mornedhels/enshrouded-server" },
  { game: "Valheim", maintainer: "lloesche / community-valheim-tools", url: "https://github.com/community-valheim-tools/valheim-server-docker" },
  { game: "7 Days to Die", maintainer: "vinanrra (LinuxGSM)", url: "https://github.com/vinanrra/Docker-7DaysToDie" },
];

function CreditsCard() {
  return (
    <div className="card space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">About</h2>
      <p className="text-xs leading-snug text-slate-400">
        This manager is only the control plane — every game server runs on a
        community-maintained Docker image. Huge thanks to the maintainers who do the real heavy
        lifting:
      </p>
      <ul className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {IMAGE_CREDITS.map((c) => (
          <li key={c.url + c.game} className="flex justify-between gap-3">
            <span className="text-slate-400">{c.game}</span>
            <a href={c.url} target="_blank" rel="noreferrer" className="text-ark-accent hover:underline">
              {c.maintainer}
            </a>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-slate-500">
        Plus SteamCMD, GE-Proton/Wine, <a href="https://thunderstore.io/" target="_blank" rel="noreferrer" className="text-ark-accent hover:underline">Thunderstore</a>, and the CurseForge + Steam Web APIs for mod browsing.
      </p>
    </div>
  );
}

function SecretField({
  label,
  value,
  onChange,
  configured,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  configured: boolean;
}) {
  return (
    <div>
      <label className="label flex items-center gap-2">
        {label}
        {configured ? (
          <span className="inline-flex items-center gap-1 text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> configured
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-slate-500">
            <Circle className="h-3.5 w-3.5" /> not set
          </span>
        )}
      </label>
      <input
        type="password"
        className="input"
        placeholder={configured ? "•••••••• (leave blank to keep)" : "Paste key…"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
