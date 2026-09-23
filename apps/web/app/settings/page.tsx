"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Save, Settings, Send, CheckCircle2, Circle } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { DEFAULT_LOG_LEVEL, GAME_LABELS, Game, LOG_LEVELS, type LogLevel } from "@ark/shared";
import { TimezoneSelect, detectZone } from "@/components/timezone-select";
import { NotificationTargetsCard } from "@/components/notification-targets";
import { ReplicationCard } from "@/components/replication-card";
import { UsersCard } from "@/components/users-card";
import { toast } from "@/components/dialogs";
import { keepCase } from "@/lib/keep-case";

type SettingsView = Record<string, string | boolean>;

const TABS = ["General", "Integrations", "Backups", "Users", "Notifications", "About"] as const;
const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const badTargetIp = (v: string) => v.trim() !== "" && !IPV4.test(v.trim());
type Tab = (typeof TABS)[number];
export default function SettingsPage() {
  const uid = useId();
  const [tab, setTab] = useState<Tab>("General");
  const [view, setView] = useState<SettingsView>({});
  const [timezone, setTimezone] = useState("");
  const [logLevel, setLogLevel] = useState<LogLevel>(DEFAULT_LOG_LEVEL);
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
  // Which router the port-forward integration drives. Unset reads as pfSense so
  // installs that predate UniFi support keep their forwards untouched.
  const [portForwardRouter, setPortForwardRouter] = useState<"pfsense" | "unifi">("pfsense");
  const [unifiHost, setUnifiHost] = useState("");
  const [unifiApiKey, setUnifiApiKey] = useState("");
  const [unifiSite, setUnifiSite] = useState("default");
  const [unifiTargetIp, setUnifiTargetIp] = useState("");
  // Host overrides. "" means "not set here" — the env var keeps deciding.
  const [gameHostNetwork, setGameHostNetwork] = useState("");
  const [autoCreateNetwork, setAutoCreateNetwork] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [connectHost, setConnectHost] = useState("");
  const [hostDataDir, setHostDataDir] = useState("");
  // Per-card save state: which card is mid-save / which just saved.
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [savedCard, setSavedCard] = useState<string | null>(null);

  /** Fetch settings and reset the fields of `card`, or of every card when omitted,
   *  so saving one card never throws away unsaved edits in another. */
  const load = (card?: string) => {
    const reset = (c: string) => card === undefined || card === c;
    apiGet<SettingsView>("/settings")
      .then((v) => {
        setView(v);
        if (reset("general")) {
          // Pre-select the user's detected zone when nothing is saved yet, so they
          // rarely have to touch it.
          setTimezone(typeof v.timezone === "string" && v.timezone ? v.timezone : detectZone());
          if (LOG_LEVELS.includes(v.log_level as LogLevel)) setLogLevel(v.log_level as LogLevel);
        }
        if (reset("backups") && typeof v.manager_backup_keep === "string" && v.manager_backup_keep)
          setManagerBackupKeep(v.manager_backup_keep);
        if (reset("startguard")) setAutoStop(v.auto_stop_on_start !== "false"); // default on when unset
        if (reset("portforwarding")) {
          if (typeof v.pfsense_host === "string") setPfsenseHost(v.pfsense_host);
          if (typeof v.pfsense_target_ip === "string") setPfsenseTargetIp(v.pfsense_target_ip);
          setPortForwardRouter(v.port_forward_router === "unifi" ? "unifi" : "pfsense");
          if (typeof v.unifi_host === "string") setUnifiHost(v.unifi_host);
          if (typeof v.unifi_site === "string" && v.unifi_site) setUnifiSite(v.unifi_site);
          if (typeof v.unifi_target_ip === "string") setUnifiTargetIp(v.unifi_target_ip);
        }
        if (reset("host")) {
          setGameHostNetwork(typeof v.game_host_network === "string" ? v.game_host_network : "");
          setAutoCreateNetwork(typeof v.auto_create_network === "string" ? v.auto_create_network : "");
          setPublicBaseUrl(typeof v.public_base_url === "string" ? v.public_base_url : "");
          setConnectHost(typeof v.connect_host === "string" ? v.connect_host : "");
          setHostDataDir(typeof v.host_data_dir === "string" ? v.host_data_dir : "");
        }
      })
      .catch(() => undefined);
  };
  useEffect(() => load(), []);

  // Keep the active tab in the URL (?tab=backups) so a refresh lands back on the
  // same tab — same pattern as the server page.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("tab");
    const found = p && TABS.find((t) => t.toLowerCase() === p.toLowerCase());
    if (found) setTab(found);
  }, []);
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
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
      load(card);
    } catch (err) {
      toast.error(err);
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

  /** Saves the router choice plus the fields of the router that's showing; the
   *  other router's saved settings stay put so switching back costs nothing. */
  const targetIpBad = badTargetIp(portForwardRouter === "unifi" ? unifiTargetIp : pfsenseTargetIp);
  const savePortForwarding = () => {
    const body: Record<string, string> = { portForwardRouter };
    if (portForwardRouter === "unifi") {
      body.unifiHost = unifiHost;
      body.unifiSite = unifiSite;
      body.unifiTargetIp = unifiTargetIp;
      if (unifiApiKey) body.unifiApiKey = unifiApiKey;
    } else {
      body.pfsenseHost = pfsenseHost;
      body.pfsenseTargetIp = pfsenseTargetIp;
      if (pfsenseApiKey) body.pfsenseApiKey = pfsenseApiKey;
    }
    void saveCard("portforwarding", body, () => {
      setPfsenseApiKey("");
      setUnifiApiKey("");
      setPfTestMsg(null);
    });
  };

  const saveBackups = () => {
    const keep = parseInt(managerBackupKeep, 10);
    if (!Number.isFinite(keep) || keep < 1) return toast.error("Keep count must be a number ≥ 1.");
    void saveCard("backups", { managerBackupKeep: keep });
  };

  const saveGeneral = () => void saveCard("general", { logLevel, ...(timezone ? { timezone } : {}) });
  /** "" (defer to the env var) has to travel as null, not "" — the API reads a
   *  missing key as "no change", and an empty string as a value. */
  const tri = (v: string) => (v === "" ? null : v === "true");
  const saveHost = () =>
    void saveCard("host", {
      gameHostNetwork: tri(gameHostNetwork),
      autoCreateNetwork: tri(autoCreateNetwork),
      publicBaseUrl,
      connectHost,
      hostDataDir,
    });
  const saveStartGuard = () => void saveCard("startguard", { autoStopOnStart: autoStop });

  const CardSave = ({ card, onClick, disabled }: { card: string; onClick: () => void; disabled?: boolean }) => (
    <div className="pt-1">
      <button className="btn-primary" onClick={onClick} disabled={busyCard === card || disabled}>
        <Save className="h-4 w-4" />{" "}
        {busyCard === card ? "Saving…" : savedCard === card ? "Saved ✓" : "Save"}
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

  // Tests what's in the form right now (a blank key falls back to the saved one),
  // so a router can be tried before Save.
  const testRouter = async () => {
    setPfTestMsg("Testing…");
    try {
      const draft =
        portForwardRouter === "unifi"
          ? { router: "unifi", host: unifiHost, apiKey: unifiApiKey, site: unifiSite, targetIp: unifiTargetIp }
          : { router: "pfsense", host: pfsenseHost, apiKey: pfsenseApiKey, targetIp: pfsenseTargetIp };
      const res = await apiPost<{ ok: boolean; message: string }>("/router/test", draft);
      setPfTestMsg(`${res.ok ? "✓ " : "✗ "}${res.message}`);
    } catch (err) {
      setPfTestMsg((err as Error).message);
    }
  };

  // UniFi only: creates and deletes a disabled rule, two config pushes to the
  // gateway, so it is a separate button the admin chooses to press.
  const testUnifiWrite = async () => {
    setPfTestMsg("Testing write access…");
    try {
      const res = await apiPost<{ ok: boolean; message: string }>("/router/test-write", {
        router: "unifi",
        host: unifiHost,
        apiKey: unifiApiKey,
        site: unifiSite,
        targetIp: unifiTargetIp,
      });
      setPfTestMsg(`${res.ok ? "✓ " : "✗ "}${res.message}`);
    } catch (err) {
      setPfTestMsg((err as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <Settings className="h-5 w-5 text-ark-accent" /> Settings
      </h1>

      <div ref={tabsRef} role="tablist" className="flex gap-1 overflow-x-auto border-b border-ark-border">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            data-active={tab === t || undefined}
            onClick={() => changeTab(t)}
            className={`shrink-0 whitespace-nowrap px-4 py-2 text-sm ${
              tab === t ? "border-b-2 border-ark-accent text-slate-100" : "text-slate-400 hover:text-slate-200"
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
              <label htmlFor={`${uid}-tz`} className="label">Timezone (scheduler)</label>
              <TimezoneSelect id={`${uid}-tz`} value={timezone} onChange={setTimezone} />
              <p className="mt-1 text-xs text-slate-500">
                Used for schedule times. Defaults to this device&apos;s timezone.
              </p>
            </div>
            <div>
              <label htmlFor={`${uid}-log`} className="label">Log level</label>
              <select id={`${uid}-log`} className="input" value={logLevel} onChange={(e) => setLogLevel(e.target.value as LogLevel)}>
                <option value="error">Errors only</option>
                <option value="warn">Warnings and errors</option>
                <option value="log">Info</option>
                <option value="debug">Debug (everything)</option>
              </select>
              <p className="mt-1 text-xs text-slate-500">
                How much the manager writes to its container log. Takes effect on save, no restart.
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
              <label htmlFor={`${uid}-hostnet`} className="label">Game server networking</label>
              <select
                id={`${uid}-hostnet`}
                className="input"
                value={gameHostNetwork}
                onChange={(e) => setGameHostNetwork(e.target.value)}
              >
                <option value="">Use environment</option>
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
              <label htmlFor={`${uid}-autonet`} className="label">Manage the Docker network automatically</label>
              <select
                id={`${uid}-autonet`}
                className="input"
                value={autoCreateNetwork}
                onChange={(e) => setAutoCreateNetwork(e.target.value)}
              >
                <option value="">Use environment</option>
                <option value="true">Yes — create and join it for me</option>
                <option value="false">No — I manage Docker networks</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-baseurl`} className="label">Public base URL</label>
              <input
                id={`${uid}-baseurl`}
                className="input"
                value={publicBaseUrl}
                placeholder="e.g. http://10.0.0.5:8970"
                onChange={(e) => setPublicBaseUrl(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                The address you actually reach Palisade at. Used for links and for the WebUI button
                on each game server in the Unraid Docker page.
              </p>
            </div>
            <div>
              <label htmlFor={`${uid}-connect`} className="label">Address players connect to</label>
              <input
                id={`${uid}-connect`}
                className="input"
                value={connectHost}
                placeholder="e.g. 10.0.0.5"
                onChange={(e) => setConnectHost(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">
                The IP or hostname players type into the game, shown on every server&apos;s connect
                card. Set it when the game servers answer somewhere other than the address you reach
                Palisade at — a manager on a custom/macvlan network and host-networked game servers
                is the usual case. Blank uses your port-forward target IP, then the public base URL,
                then the address you are browsing from.
              </p>
            </div>
            <div>
              <label htmlFor={`${uid}-datadir`} className="label">App data path on the host</label>
              <input
                id={`${uid}-datadir`}
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
              label="CurseForge API key (ASA mods and Minecraft modpacks)"
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
            <CardSave
              card="modkeys"
              onClick={saveModKeys}
              disabled={!curseForgeApiKey && !steamWebApiKey && !steamGridDbApiKey}
            />
          </div>
          <div className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">
              Port forwarding
            </h2>
            <p className="text-xs text-slate-500">
              With these set, each server&apos;s Overview gets one-click WAN port-forward management:
              create, fix, enable/disable, and delete the player-facing forwards on your router. Nothing
              is tied to a specific network.
            </p>
            <div>
              <label htmlFor={`${uid}-router`} className="label">Router</label>
              <select
                id={`${uid}-router`}
                className="input"
                value={portForwardRouter}
                onChange={(e) => {
                  setPortForwardRouter(e.target.value === "unifi" ? "unifi" : "pfsense");
                  setPfTestMsg(null);
                }}
              >
                <option value="pfsense">pfSense (REST API package)</option>
                <option value="unifi">UniFi Network (UniFi OS console)</option>
              </select>
            </div>
            {portForwardRouter === "pfsense" ? (
              <>
                <p className="text-xs text-slate-500">
                  Requires the free{" "}
                  <a
                    href="https://pfrest.org/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-ark-accent hover:underline"
                  >
                    pfSense REST API package
                  </a>{" "}
                  on your router (System → REST API → generate an API key).
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`${uid}-pfhost`} className="label">{keepCase("pfSense host / IP")}</label>
                    <input
                      id={`${uid}-pfhost`}
                      className="input"
                      placeholder="e.g. 192.168.1.1 (your router)"
                      value={pfsenseHost}
                      onChange={(e) => setPfsenseHost(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor={`${uid}-pftarget`} className="label">Forward to (LAN IP)</label>
                    <input
                      id={`${uid}-pftarget`}
                      className={`input ${badTargetIp(pfsenseTargetIp) ? "border-rose-500/60" : ""}`}
                      placeholder="e.g. 192.168.1.50 (this server box)"
                      value={pfsenseTargetIp}
                      onChange={(e) => setPfsenseTargetIp(e.target.value)}
                      aria-invalid={badTargetIp(pfsenseTargetIp)}
                    />
                    {badTargetIp(pfsenseTargetIp) && (
                      <p className="mt-1 text-xs text-rose-400">Enter an IPv4 address, e.g. 192.168.1.50.</p>
                    )}
                  </div>
                </div>
                <SecretField
                  label="pfSense REST API key"
                  value={pfsenseApiKey}
                  onChange={setPfsenseApiKey}
                  configured={configured("pfsense_api_key")}
                />
              </>
            ) : (
              <>
                <p className="text-xs text-slate-500">
                  Works with UniFi OS consoles (Dream Machine, Cloud Gateway, Cloud Key) on Network 9.0 or
                  newer. Create an API key in the Network app under Settings → Control Plane → Integrations;
                  the key inherits the role of the admin who creates it, so use a full admin, not a
                  view-only one. Multi-site setups: use the site&apos;s short name from the URL
                  (usually <span className="font-mono text-slate-400">default</span>).
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`${uid}-unhost`} className="label">Console host / IP</label>
                    <input
                      id={`${uid}-unhost`}
                      className="input"
                      placeholder="e.g. 192.168.1.1 (your gateway)"
                      value={unifiHost}
                      onChange={(e) => setUnifiHost(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor={`${uid}-untarget`} className="label">Forward to (LAN IP)</label>
                    <input
                      id={`${uid}-untarget`}
                      className={`input ${badTargetIp(unifiTargetIp) ? "border-rose-500/60" : ""}`}
                      placeholder="e.g. 192.168.1.50 (this server box)"
                      value={unifiTargetIp}
                      onChange={(e) => setUnifiTargetIp(e.target.value)}
                      aria-invalid={badTargetIp(unifiTargetIp)}
                    />
                    {badTargetIp(unifiTargetIp) && (
                      <p className="mt-1 text-xs text-rose-400">Enter an IPv4 address, e.g. 192.168.1.50.</p>
                    )}
                  </div>
                  <div>
                    <label htmlFor={`${uid}-site`} className="label">Site</label>
                    <input
                      id={`${uid}-site`}
                      className="input"
                      placeholder="default"
                      value={unifiSite}
                      onChange={(e) => setUnifiSite(e.target.value)}
                    />
                  </div>
                </div>
                <SecretField
                  label="UniFi API key"
                  value={unifiApiKey}
                  onChange={setUnifiApiKey}
                  configured={configured("unifi_api_key")}
                />
              </>
            )}
            <div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={testRouter}>
                  <Send className="h-4 w-4" /> Test connection
                </button>
                {portForwardRouter === "unifi" && (
                  <button type="button" className="btn-secondary" onClick={testUnifiWrite}>
                    <Send className="h-4 w-4" /> Test write access
                  </button>
                )}
              </div>
              {portForwardRouter === "unifi" && (
                <p className="mt-2 text-xs text-slate-500">
                  Test connection only reads. Test write access creates a disabled rule named{" "}
                  <span className="font-mono text-slate-400">Palisade - write test (safe to delete)</span> and deletes
                  it again. Each of those two steps is a real config change that UniFi pushes to the gateway, so
                  run it when a brief firewall reload would be acceptable.
                </p>
              )}
              {pfTestMsg && <p className="mt-2 text-sm text-slate-400">{pfTestMsg}</p>}
            </div>
            <CardSave card="portforwarding" onClick={savePortForwarding} disabled={targetIpBad} />
          </div>
        </>
      )}

      {tab === "Backups" && (
        <>
          <div className="card space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">Backups</h2>
            <div>
              <label htmlFor={`${uid}-dbkeep`} className="label">Keep last N Palisade database backups</label>
              <input
                id={`${uid}-dbkeep`}
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
const IMAGE_CREDITS: { game: Game; maintainer: string; url: string }[] = [
  { game: Game.ASA, maintainer: "Acekorneya (POK)", url: "https://github.com/Acekorneya/Ark-Survival-Ascended-Server" },
  { game: Game.CONAN, maintainer: "Acekorneya (POK)", url: "https://github.com/Acekorneya/POK_Conan_Enhanced_Docker_server" },
  { game: Game.ASE, maintainer: "Hermsi1337", url: "https://github.com/Hermsi1337/docker-ark-server" },
  { game: Game.PALWORLD, maintainer: "Thijs van Loef", url: "https://github.com/thijsvanloef/palworld-server-docker" },
  { game: Game.MINECRAFT, maintainer: "itzg", url: "https://github.com/itzg/docker-minecraft-server" },
  { game: Game.BEDROCK, maintainer: "itzg", url: "https://github.com/itzg/docker-minecraft-bedrock-server" },
  { game: Game.ICARUS, maintainer: "mornedhels", url: "https://github.com/mornedhels/icarus-server" },
  { game: Game.ENSHROUDED, maintainer: "mornedhels", url: "https://github.com/mornedhels/enshrouded-server" },
  { game: Game.VALHEIM, maintainer: "lloesche / community-valheim-tools", url: "https://github.com/community-valheim-tools/valheim-server-docker" },
  { game: Game.SEVEN_DAYS, maintainer: "vinanrra (LinuxGSM)", url: "https://github.com/vinanrra/Docker-7DaysToDie" },
  { game: Game.PALWORLD_WINE, maintainer: "ripps818", url: "https://github.com/ripps818/docker-palworld-dedicated-server-wine" },
  { game: Game.ZOMBOID, maintainer: "Danixu", url: "https://github.com/danixu/project-zomboid-server-docker" },
  { game: Game.VRISING, maintainer: "TrueOsiris", url: "https://github.com/TrueOsiris/docker-vrising" },
  { game: Game.SOTF, maintainer: "jammsen", url: "https://github.com/jammsen/docker-sons-of-the-forest-dedicated-server" },
  { game: Game.SATISFACTORY, maintainer: "wolveix", url: "https://github.com/wolveix/satisfactory-server" },
  { game: Game.LIF, maintainer: "ich777", url: "https://github.com/ich777/docker-steamcmd-server" },
  { game: Game.ATS, maintainer: "ich777", url: "https://github.com/ich777/docker-steamcmd-server" },
  { game: Game.ETS2, maintainer: "ich777", url: "https://github.com/ich777/docker-steamcmd-server" },
  { game: Game.OPENTTD, maintainer: "ich777", url: "https://hub.docker.com/r/ich777/openttdserver" },
  { game: Game.CORE_KEEPER, maintainer: "Escaping Network", url: "https://github.com/escapingnetwork/core-keeper-dedicated" },
  { game: Game.TERRARIA, maintainer: "Ryan Sheehan", url: "https://github.com/ryansheehan/terraria" },
  { game: Game.FACTORIO, maintainer: "factoriotools", url: "https://github.com/factoriotools/factorio-docker" },
  { game: Game.RUST, maintainer: "Didstopia", url: "https://github.com/Didstopia/rust-server" },
  { game: Game.BEAMMP, maintainer: "RouHim", url: "https://github.com/RouHim/beammp-container-image" },
  { game: Game.CS2, maintainer: "joedwards32", url: "https://github.com/joedwards32/CS2" },
  { game: Game.DST, maintainer: "Jamesits", url: "https://github.com/Jamesits/docker-dst-server" },
  { game: Game.DRAGONWILDS, maintainer: "blckassassin", url: "https://github.com/blckassassin/unraid-game-servers" },
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
            <span className="text-slate-400">{GAME_LABELS[c.game]}</span>
            <a href={c.url} target="_blank" rel="noreferrer" className="text-ark-accent hover:underline">
              {c.maintainer}
            </a>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-slate-500">
        Plus SteamCMD, GE-Proton/Wine, <a href="https://thunderstore.io/" target="_blank" rel="noreferrer" className="text-ark-accent hover:underline">Thunderstore</a>, <a href="https://hexium.gg/" target="_blank" rel="noreferrer" className="text-ark-accent hover:underline">Hexium</a>, and the CurseForge + Steam Web APIs for mod browsing.
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
  const uid = useId();
  return (
    <div>
      <label htmlFor={`${uid}-secret`} className="label flex items-start gap-2">
        <span>{keepCase(label)}</span>
        {configured ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> configured
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 text-slate-500">
            <Circle className="h-3.5 w-3.5" /> not set
          </span>
        )}
      </label>
      <input
        id={`${uid}-secret`}
        type="password"
        className="input"
        placeholder={configured ? "•••••••• (leave blank to keep)" : "Paste key…"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
