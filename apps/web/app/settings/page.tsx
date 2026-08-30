"use client";
import { useEffect, useState } from "react";
import { Save, KeyRound, Send, CheckCircle2, Circle } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { TimezoneSelect, detectZone } from "@/components/timezone-select";
import { NotificationTargetsCard } from "@/components/notification-targets";
import { ReplicationCard } from "@/components/replication-card";
import { UsersCard } from "@/components/users-card";

type SettingsView = Record<string, string | boolean>;

const TABS = ["General", "Integrations", "Backups", "Users", "Notifications", "About"] as const;
type Tab = (typeof TABS)[number];
export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("General");
  const [view, setView] = useState<SettingsView>({});
  const [timezone, setTimezone] = useState("");
  const [curseForgeApiKey, setCurseForgeApiKey] = useState("");
  const [steamWebApiKey, setSteamWebApiKey] = useState("");
  const [steamGridDbApiKey, setSteamGridDbApiKey] = useState("");
  const [artMsg, setArtMsg] = useState<string | null>(null);
  const [managerBackupKeep, setManagerBackupKeep] = useState("14");
  const [autoStop, setAutoStop] = useState(true);
  const [pfsenseHost, setPfsenseHost] = useState("");
  const [pfsenseApiKey, setPfsenseApiKey] = useState("");
  const [pfsenseTargetIp, setPfsenseTargetIp] = useState("");
  const [pfTestMsg, setPfTestMsg] = useState<string | null>(null);
  // Host overrides. "" means "not set here" — the env var keeps deciding.
  const [gameHostNetwork, setGameHostNetwork] = useState("");
  const [autoCreateNetwork, setAutoCreateNetwork] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [hostDataDir, setHostDataDir] = useState("");
  // Per-card save state: which card is mid-save / which just saved.
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [savedCard, setSavedCard] = useState<string | null>(null);

  const load = () => {
    apiGet<SettingsView>("/settings")
      .then((v) => {
        setView(v);
        // Pre-select the user's detected zone when nothing is saved yet, so they
        // rarely have to touch it.
        setTimezone(typeof v.timezone === "string" && v.timezone ? v.timezone : detectZone());
        if (typeof v.manager_backup_keep === "string" && v.manager_backup_keep)
          setManagerBackupKeep(v.manager_backup_keep);
        setAutoStop(v.auto_stop_on_start !== "false"); // default on when unset
        if (typeof v.pfsense_host === "string") setPfsenseHost(v.pfsense_host);
        if (typeof v.pfsense_target_ip === "string") setPfsenseTargetIp(v.pfsense_target_ip);
        setGameHostNetwork(typeof v.game_host_network === "string" ? v.game_host_network : "");
        setAutoCreateNetwork(typeof v.auto_create_network === "string" ? v.auto_create_network : "");
        setPublicBaseUrl(typeof v.public_base_url === "string" ? v.public_base_url : "");
        setHostDataDir(typeof v.host_data_dir === "string" ? v.host_data_dir : "");
      })
      .catch(() => undefined);
  };
  useEffect(load, []);

  // Keep the active tab in the URL (?tab=backups) so a refresh lands back on the
  // same tab — same pattern as the server page.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("tab");
    const found = p && TABS.find((t) => t.toLowerCase() === p.toLowerCase());
    if (found) setTab(found);
  }, []);
  const changeTab = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", t.toLowerCase());
    window.history.replaceState(null, "", u);
  };

  const configured = (key: string) => view[key] === true || typeof view[key] === "string";

  /** Save ONE card's fields; `after` clears write-only secret inputs on success. */
  const saveCard = async (
    card: string,
    body: Record<string, string | number | boolean | null>,
    after?: () => void,
  ) => {
    setBusyCard(card);
    setSavedCard(null);
    try {
      await apiPatch("/settings", body);
      after?.();
      setSavedCard(card);
      load();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusyCard(null);
    }
  };

  const saveModKeys = () => {
    const body: Record<string, string> = {};
    if (curseForgeApiKey) body.curseForgeApiKey = curseForgeApiKey;
    if (steamWebApiKey) body.steamWebApiKey = steamWebApiKey;
    if (steamGridDbApiKey) body.steamGridDbApiKey = steamGridDbApiKey;
    void saveCard("modkeys", body, () => {
      setCurseForgeApiKey("");
      setSteamWebApiKey("");
      setSteamGridDbApiKey("");
    });
  };

  const savePfsense = () => {
    const body: Record<string, string> = { pfsenseHost, pfsenseTargetIp };
    if (pfsenseApiKey) body.pfsenseApiKey = pfsenseApiKey;
    void saveCard("pfsense", body, () => setPfsenseApiKey(""));
  };

  const saveBackups = () => {
    const keep = parseInt(managerBackupKeep, 10);
    if (!Number.isFinite(keep) || keep < 1) return alert("Keep count must be a number ≥ 1.");
    void saveCard("backups", { managerBackupKeep: keep });
  };

  const saveGeneral = () => void saveCard("general", timezone ? { timezone } : {});
  /** "" (defer to the env var) has to travel as null, not "" — the API reads a
   *  missing key as "no change", and an empty string as a value. */
  const tri = (v: string) => (v === "" ? null : v === "true");
  const saveHost = () =>
    void saveCard("host", {
      gameHostNetwork: tri(gameHostNetwork),
      autoCreateNetwork: tri(autoCreateNetwork),
      publicBaseUrl,
      hostDataDir,
    });
  const saveStartGuard = () => void saveCard("startguard", { autoStopOnStart: autoStop });

  const CardSave = ({ card, onClick }: { card: string; onClick: () => void }) => (
    <div className="pt-1">
      <button className="btn-primary" onClick={onClick} disabled={busyCard === card}>
        <Save className="h-4 w-4" />{" "}
        {busyCard === card ? "Saving…" : savedCard === card ? "Saved ✓" : "Save settings"}
      </button>
    </div>
  );

  // Fetches art for every game with the SAVED key — save first if the field is dirty.
  const fetchArtwork = async () => {
    setArtMsg("Fetching…");
    try {
      const r = await apiPost<{ fetched: number; missing: number }>("/artwork/refresh");
      setArtMsg(
        r.fetched > 0
          ? `Found art for ${r.fetched} game${r.fetched === 1 ? "" : "s"} (reload to see it).`
          : "No art fetched — save a valid SteamGridDB key first.",
      );
    } catch (err) {
      setArtMsg((err as Error).message);
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

      <div className="flex flex-wrap gap-1 border-b border-ark-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => changeTab(t)}
            className={`px-4 py-2 text-sm ${
              tab === t ? "border-b-2 border-ark-accent text-slate-100" : "text-slate-400"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "General" && (
        <>
          <div className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">General</h2>
            <div>
              <label className="label">Timezone (scheduler)</label>
              <TimezoneSelect value={timezone} onChange={setTimezone} />
              <p className="mt-1 text-xs text-slate-500">
                Used for schedule times. Defaults to this device&apos;s timezone.
              </p>
            </div>
            <CardSave card="general" onClick={saveGeneral} />
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
            <CardSave card="startguard" onClick={saveStartGuard} />
          </div>
          <div className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">
              Host &amp; networking
            </h2>
            <p className="text-xs text-slate-500">
              These were container environment variables. Leave anything on{" "}
              <span className="text-slate-400">Use environment</span> or blank to keep using the value
              from your Docker template. Changes apply to each game server the next time it starts.
            </p>
            <div>
              <label className="label">Game server networking</label>
              <select
                className="input"
                value={gameHostNetwork}
                onChange={(e) => setGameHostNetwork(e.target.value)}
              >
                <option value="">Use environment (GAME_HOST_NETWORK)</option>
                <option value="true">Host network</option>
                <option value="false">Shared bridge</option>
              </select>
              <p className="mt-1 text-xs text-slate-500">
                Host networking makes ARK/EOS advertise your real address, which lists more
                reliably; the bridge keeps ports isolated. Individual servers can override this on
                their own Settings tab.
              </p>
            </div>
            <div>
              <label className="label">Manage the Docker network automatically</label>
              <select
                className="input"
                value={autoCreateNetwork}
                onChange={(e) => setAutoCreateNetwork(e.target.value)}
              >
                <option value="">Use environment (AUTO_CREATE_NETWORK)</option>
                <option value="true">Yes — create and join it for me</option>
                <option value="false">No — I manage Docker networks myself</option>
              </select>
            </div>
            <div>
              <label className="label">Public base URL</label>
              <input
                className="input"
                value={publicBaseUrl}
                placeholder="http://10.0.0.5:8970 — blank to use PUBLIC_BASE_URL"
                onChange={(e) => setPublicBaseUrl(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                The address you actually reach Palisade at. Used for links and for the WebUI button
                on each game server in the Unraid Docker page.
              </p>
            </div>
            <div>
              <label className="label">App data path on the host</label>
              <input
                className="input"
                value={hostDataDir}
                placeholder="Blank — auto-detected from this container's /data mount"
                onChange={(e) => setHostDataDir(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                Where game files are bind-mounted from. Palisade detects this from its own /data
                mount, so leave it blank unless the banner says the two disagree. Applies
                immediately, to the next server you start.
              </p>
            </div>
            <CardSave card="host" onClick={saveHost} />
          </div>
        </>
      )}

      {tab === "Integrations" && (
        <>
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
            <div className="space-y-2 border-t border-ark-border/60 pt-4">
              <SecretField
                label="SteamGridDB API key (cover art + banners)"
                value={steamGridDbApiKey}
                onChange={setSteamGridDbApiKey}
                configured={configured("steamgriddb_api_key")}
              />
              <p className="text-xs text-slate-500">
                Adds cover art to server cards and a banner to each server page. Free key from{" "}
                <a
                  href="https://www.steamgriddb.com/profile/preferences/api"
                  target="_blank"
                  rel="noreferrer"
                  className="text-ark-accent hover:underline"
                >
                  steamgriddb.com
                </a>
                . Save the key first, then fetch — art is cached, so this is a one-time pull.
              </p>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-secondary" onClick={fetchArtwork}>
                  <Send className="h-4 w-4" /> Fetch artwork
                </button>
                {artMsg && <span className="text-sm text-slate-400">{artMsg}</span>}
              </div>
            </div>
            <CardSave card="modkeys" onClick={saveModKeys} />
          </div>
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
            <CardSave card="pfsense" onClick={savePfsense} />
          </div>
        </>
      )}

      {tab === "Backups" && (
        <>
          <div className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">Backups</h2>
            <div>
              <label className="label">Keep last N Palisade database backups</label>
              <input
                type="number"
                min={1}
                max={500}
                className="input w-32"
                value={managerBackupKeep}
                onChange={(e) => setManagerBackupKeep(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                Palisade snapshots its own database (servers, settings, schedules, players)
                nightly into <span className="font-mono">backups/_manager</span>. This is how many
                of those to keep. Default 14; anything from 1 to 500 works.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                <span className="text-slate-400">Game-server backups are configured per server</span>
                , on each server&apos;s Backups tab — save sizes and useful history differ too much
                between games for one number. Backups you take by hand are never rotated away.
              </p>
            </div>
            <CardSave card="backups" onClick={saveBackups} />
          </div>
          <ReplicationCard />
        </>
      )}

      {tab === "Users" && <UsersCard />}
      {tab === "Notifications" && <NotificationTargetsCard />}
      {tab === "About" && <CreditsCard />}
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
  { game: "Palworld (Wine)", maintainer: "ripps818", url: "https://github.com/ripps818/docker-palworld-dedicated-server-wine" },
  { game: "Project Zomboid", maintainer: "Danixu", url: "https://github.com/danixu/project-zomboid-server-docker" },
  { game: "V Rising", maintainer: "TrueOsiris", url: "https://github.com/TrueOsiris/docker-vrising" },
  { game: "Sons of the Forest", maintainer: "jammsen", url: "https://github.com/jammsen/docker-sons-of-the-forest-dedicated-server" },
  { game: "Satisfactory", maintainer: "wolveix", url: "https://github.com/wolveix/satisfactory-server" },
  { game: "Life is Feudal: YO", maintainer: "ich777", url: "https://github.com/ich777/docker-steamcmd-server" },
  { game: "American Truck Simulator", maintainer: "ich777", url: "https://github.com/ich777/docker-steamcmd-server" },
  { game: "Euro Truck Simulator 2", maintainer: "ich777", url: "https://github.com/ich777/docker-steamcmd-server" },
  { game: "OpenTTD", maintainer: "ich777", url: "https://hub.docker.com/r/ich777/openttdserver" },
  { game: "Core Keeper", maintainer: "Escaping Network", url: "https://github.com/escapingnetwork/core-keeper-dedicated" },
  { game: "Terraria (TShock)", maintainer: "Ryan Sheehan", url: "https://github.com/ryansheehan/terraria" },
  { game: "Factorio", maintainer: "factoriotools", url: "https://github.com/factoriotools/factorio-docker" },
  { game: "Rust", maintainer: "Didstopia", url: "https://github.com/Didstopia/rust-server" },
  { game: "BeamNG.drive (BeamMP)", maintainer: "RouHim", url: "https://github.com/RouHim/beammp-container-image" },
  { game: "Counter-Strike 2", maintainer: "joedwards32", url: "https://github.com/joedwards32/CS2" },
  { game: "Don't Starve Together", maintainer: "Jamesits", url: "https://github.com/Jamesits/docker-dst-server" },
];

function CreditsCard() {
  return (
    <div className="card space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">About</h2>
      <p className="text-xs leading-snug text-slate-400">
        This manager is only the control plane — every game server runs on a
        community-maintained Docker image. Huge thanks to the maintainers who do the real heavy
        lifting (each game&apos;s quirks are covered in its Guide tab):
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
        Game artwork — covers, banners, and logos — comes from the wonderful{" "}
        <a href="https://www.steamgriddb.com/" target="_blank" rel="noreferrer" className="text-ark-accent hover:underline">SteamGridDB</a>{" "}
        community (bring your own free API key), with Steam&apos;s CDN header images as the fallback.
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
