"use client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Play, Square, RotateCw, Download, Loader2, Pencil, Check, X, Trash2, AlertTriangle } from "lucide-react";
import { mapLabel, Game, ServerState, type ServerSummary, type ServerConfigValues } from "@ark/shared";
import { apiGet, apiPost, apiPatch, apiDelete, apiDownload } from "@/lib/api";
import { useRealtime } from "@/lib/socket";
import { StateBadge } from "@/components/state-badge";
import { UpdateBadge } from "@/components/update-badge";
import { ConnectCommand } from "@/components/connect-command";
import { UnofficialListHelp } from "@/components/unofficial-list-help";
import { SettingsForm } from "@/components/settings-form";
import { CopyMenu } from "@/components/copy-menu";
import { RconConsole } from "@/components/rcon-console";
import { ResourcesPanel } from "@/components/resources-panel";
import { ServerAccessCard } from "@/components/server-access-card";
import { AccessListsCard } from "@/components/access-lists-card";
import { PortsCard } from "@/components/ports-card";
import { GeneralCard } from "@/components/general-card";
import { PortForwardsCard } from "@/components/port-forwards-card";
import { LogsTab } from "@/components/logs-tab";
import { ScheduleList } from "@/components/schedule-list";
import { ModsTab } from "@/components/mods-tab";
import { PalworldModsTab } from "@/components/palworld-mods-tab";
import { MinecraftModsTab } from "@/components/minecraft-mods-tab";
import { IcarusModsTab } from "@/components/icarus-mods-tab";
import { BedrockModsTab } from "@/components/bedrock-mods-tab";
import { SevenDaysModsTab } from "@/components/sevendays-mods-tab";
import { ValheimModsTab } from "@/components/valheim-mods-tab";
import { useStartGuard } from "@/components/start-guard";
import { BackupsTab } from "@/components/backups-tab";
import { PlayersTab } from "@/components/players-tab";

const TABS = ["Overview", "Settings", "Mods", "Players", "Console", "Logs", "Schedules", "Backups"] as const;
type Tab = (typeof TABS)[number];

export default function ServerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [server, setServer] = useState<ServerSummary | null>(null);
  const [config, setConfig] = useState<ServerConfigValues | null>(null);
  const [configKey, setConfigKey] = useState(0); // bump to remount the editor on copy-in
  const [tab, setTab] = useState<Tab>("Overview");
  const [pending, setPending] = useState<"install" | "start" | "stop" | "restart" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Keep the active tab in the URL (?tab=settings) so a refresh lands you back
  // on the same tab instead of Overview. Uses replaceState — no scroll/navigation.
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

  const refresh = useCallback(
    () => apiGet<ServerSummary>(`/servers/${id}`).then(setServer).catch(() => undefined),
    [id],
  );

  // Re-fetch server + config and remount the settings editor (used after a
  // "copy from another server", which replaces this server's config wholesale).
  const reload = useCallback(() => {
    refresh();
    apiGet<ServerConfigValues>(`/servers/${id}/config`)
      .then((c) => {
        setConfig(c);
        setConfigKey((k) => k + 1);
      })
      .catch(() => undefined);
  }, [id, refresh]);

  useEffect(() => {
    reload();
  }, [id, reload]);

  useRealtime((msg) => {
    if (msg.serverId === id && (msg.topic === "server.state" || msg.topic === "event")) refresh();
  }, id);

  const startRename = () => {
    if (server) setNameDraft(server.name);
    setRenaming(true);
  };
  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next || next === server?.name) {
      setRenaming(false);
      return;
    }
    setSavingName(true);
    try {
      await apiPatch(`/servers/${id}`, { name: next });
      await refresh();
      setRenaming(false);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSavingName(false);
    }
  };

  const { start: guardedStart, dialog: startDialog, starting } = useStartGuard(refresh);

  const act = async (action: "install" | "start" | "stop" | "restart") => {
    if (action === "start") {
      // RAM-guarded start (surfaces a "stop one to free RAM" dialog if needed).
      if (server) await guardedStart(id, server.name);
      return;
    }
    setPending(action);
    try {
      await apiPost(`/servers/${id}/${action}`);
      await refresh(); // await so the button stays disabled until the new state lands
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  const doDelete = async (wipeFiles: boolean) => {
    setDeleting(true);
    try {
      await apiDelete(`/servers/${id}?wipe=${wipeFiles ? "1" : "0"}`);
      router.push("/"); // gone — back to the server list
    } catch (e) {
      alert((e as Error).message);
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  if (!server) return <div className="text-slate-400">Loading…</div>;

  // Button availability follows the server state machine; `pending` covers the
  // click→response gap so a button can't be re-clicked before its state lands.
  const st = server.state;
  const canStart = (st === ServerState.Stopped || st === ServerState.Crashed) && !pending && !starting;
  const canStop = (st === ServerState.Running || st === ServerState.Starting) && !pending;
  const canRestart = st === ServerState.Running && !pending;
  const canInstall = (st === ServerState.Stopped || st === ServerState.Crashed) && !pending;
  const showStarting = pending === "start" || starting || st === ServerState.Starting;
  const showStopping = pending === "stop" || st === ServerState.Stopping;
  const showInstalling =
    pending === "install" || st === ServerState.Installing || st === ServerState.Updating;

  // No-RCON games hide the Console tab. Icarus + Bedrock keep an uploader Mods tab
  // (.pak files / add-on packs); Valheim's mods are settings toggles (BepInEx/
  // ValheimPlus), so it hides Mods too.
  const hiddenTabs =
    server.game === Game.ICARUS || server.game === Game.BEDROCK
      ? new Set<Tab>(["Console"])
      : server.game === Game.SEVEN_DAYS
        ? new Set<Tab>() // telnet console + mod uploader — both tabs shown
        : server.game === Game.VALHEIM
          ? new Set<Tab>(["Console"]) // no RCON, but a Thunderstore mod browser
          : server.game === Game.ENSHROUDED
            ? new Set<Tab>(["Console", "Mods"]) // no RCON, no mod support
            : new Set<Tab>();
  const visibleTabs = TABS.filter((t) => !hiddenTabs.has(t));

  return (
    <div className="space-y-6">
      {startDialog}
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200">
        <ArrowLeft className="h-4 w-4" /> All servers
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                className="input py-1 text-2xl font-semibold"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setRenaming(false);
                }}
                disabled={savingName}
              />
              <button className="btn-primary" onClick={() => void saveName()} disabled={savingName} title="Save name">
                {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
              <button className="btn-secondary" onClick={() => setRenaming(false)} disabled={savingName} title="Cancel">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-semibold">{server.name}</h1>
              <button
                onClick={startRename}
                className="text-slate-400 hover:text-slate-200"
                title="Rename server"
              >
                <Pencil className="h-4 w-4" />
              </button>
            </>
          )}
          <StateBadge state={server.state} />
          {server.updateAvailable && <UpdateBadge />}
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyMenu server={server} onAfterCopyIn={reload} />
          <button className="btn-secondary" disabled={!canInstall} onClick={() => act("install")}>
            {showInstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{" "}
            {showInstalling ? "Installing…" : "Install / Update"}
          </button>
          <button className="btn-primary" disabled={!canStart} onClick={() => act("start")}>
            {showStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}{" "}
            {showStarting ? "Starting…" : "Start"}
          </button>
          <button className="btn-secondary" disabled={!canRestart} onClick={() => act("restart")}>
            {pending === "restart" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}{" "}
            {pending === "restart" ? "Restarting…" : "Restart"}
          </button>
          <button className="btn-secondary" disabled={!canStop} onClick={() => act("stop")}>
            {showStopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}{" "}
            {showStopping ? "Stopping…" : "Stop"}
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-1.5 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-900/50 disabled:opacity-50"
            disabled={!!pending || deleting}
            onClick={() => setConfirmingDelete(true)}
            title="Delete this server permanently"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>
      </div>

      {confirmingDelete && (
        <DeleteConfirm
          server={server}
          deleting={deleting}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={doDelete}
        />
      )}

      <div className="flex gap-1 border-b border-ark-border">
        {visibleTabs.map((t) => (
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

      {tab === "Overview" && <Overview server={server} onChanged={refresh} />}
      {tab === "Settings" &&
        (config ? (
          <SettingsForm key={configKey} serverId={id} game={server.game} map={server.map} initial={config} />
        ) : (
          <div className="text-slate-400">Loading settings…</div>
        ))}
      {tab === "Mods" &&
        (server.game === Game.PALWORLD ? (
          <PalworldModsTab serverId={id} />
        ) : server.game === Game.MINECRAFT ? (
          <MinecraftModsTab serverId={id} />
        ) : server.game === Game.ICARUS ? (
          <IcarusModsTab serverId={id} />
        ) : server.game === Game.BEDROCK ? (
          <BedrockModsTab serverId={id} />
        ) : server.game === Game.SEVEN_DAYS ? (
          <SevenDaysModsTab serverId={id} />
        ) : server.game === Game.VALHEIM ? (
          <ValheimModsTab serverId={id} />
        ) : (
          <ModsTab serverId={id} game={server.game} />
        ))}
      {tab === "Console" && server.game !== Game.ICARUS && (
        <RconConsole serverId={id} game={server.game} state={server.state} />
      )}
      {tab === "Players" && <PlayersTab serverId={id} />}
      {tab === "Logs" && <LogsTab serverId={id} />}
      {tab === "Schedules" && <ScheduleList serverId={id} />}
      {tab === "Backups" && <BackupsTab serverId={id} />}
    </div>
  );
}

/**
 * Destructive-delete confirmation, gated behind typing the server's name (a
 * deliberate friction, like GitHub's repo delete). The user chooses whether the
 * on-disk game data + backups are wiped too, and can download the world saves
 * through the browser first (a tar.gz of the save dirs, not the game install).
 */
function DeleteConfirm({
  server,
  deleting,
  onCancel,
  onConfirm,
}: {
  server: ServerSummary;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: (wipeFiles: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  const [wipeFiles, setWipeFiles] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  // Case-insensitive: the confirm is friction against accidents, not a password —
  // and label styling must never be able to make the shown name untypeable again.
  const armed = typed.trim().toLowerCase() === server.name.trim().toLowerCase();
  const isLive = server.state === ServerState.Running || server.state === ServerState.Starting;

  const download = async () => {
    setDownloading(true);
    setDlError(null);
    try {
      await apiDownload(`/servers/${server.id}/download`, `${server.name}-saves.tar.gz`);
      setDownloaded(true);
    } catch (e) {
      setDlError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-lg border border-rose-900/60 bg-ark-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2 text-rose-300">
          <AlertTriangle className="h-5 w-5" />
          <h2 className="text-lg font-semibold">Delete “{server.name}”?</h2>
        </div>
        <p className="text-sm leading-snug text-slate-300">
          This permanently removes the server{isLive ? " (it will be force-stopped first)" : ""}. This cannot
          be undone.
        </p>

        {/* Keep-or-wipe choice */}
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-md border border-ark-border bg-ark-bg p-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-rose-500"
            checked={wipeFiles}
            onChange={(e) => setWipeFiles(e.target.checked)}
          />
          <span className="text-sm leading-snug">
            <span className="font-medium text-slate-100">
              Also delete the game data and backups from disk
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              {wipeFiles
                ? "The game files, world saves, and every backup are wiped. Uncheck to keep them on disk after the server is removed."
                : "Files stay on the server's disk (instances/ and backups/) for manual recovery later."}
            </span>
          </span>
        </label>

        {/* Download-before-delete */}
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-ark-border bg-ark-bg p-3">
          <div className="min-w-0 text-xs leading-snug text-slate-400">
            <span className="block font-medium text-slate-200">Keep a copy first?</span>
            Download the world saves (tar.gz) through your browser before deleting.
          </div>
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={download}
            disabled={downloading || deleting}
          >
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : downloaded ? (
              <Check className="h-4 w-4 text-ark-accent" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {downloading ? "Preparing…" : downloaded ? "Downloaded" : "Download"}
          </button>
        </div>
        {dlError && <p className="mt-1.5 text-xs text-rose-400">{dlError}</p>}

        <label className="label mt-4">
          {/* normal-case: .label is uppercase, which would render the name wrong */}
          Type <span className="font-mono normal-case text-slate-200">{server.name}</span> to confirm
        </label>
        <input
          autoFocus
          className="input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && armed && !deleting) onConfirm(wipeFiles);
            if (e.key === "Escape") onCancel();
          }}
          placeholder={server.name}
        />
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel} disabled={deleting}>
            Cancel
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-40"
            disabled={!armed || deleting}
            onClick={() => onConfirm(wipeFiles)}
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {deleting ? "Deleting…" : wipeFiles ? "Delete everything" : "Delete server, keep files"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Overview({ server, onChanged }: { server: ServerSummary; onChanged: () => void }) {
  // Minecraft Java's game port is TCP + has no Steam query; Bedrock is UDP with no
  // query either; Icarus + Bedrock have no RCON and no numeric mod list.
  const isMc = server.game === Game.MINECRAFT;
  const isIcarus = server.game === Game.ICARUS;
  const isBedrock = server.game === Game.BEDROCK;
  const isValheim = server.game === Game.VALHEIM;
  const isSdtd = server.game === Game.SEVEN_DAYS;
  const isEnshrouded = server.game === Game.ENSHROUDED;
  const isZomboid = server.game === Game.ZOMBOID;
  const noQuery = isMc || isBedrock || isSdtd || isZomboid; // Valheim + Enshrouded have a real query port; Zomboid's mirrors the game port
  const noRcon = isIcarus || isBedrock || isValheim || isSdtd || isEnshrouded; // 7DTD's console is telnet
  const noMods = isIcarus || isBedrock || isValheim || isSdtd || isEnshrouded;
  const row = (k: string, v: string): [string, string] => [k, v];
  const rows: [string, string][] = [
    row("Game", server.game),
    row("Map", mapLabel(server.map)),
    row("Game port", `${server.ports.game}/${isMc ? "tcp" : "udp"}`),
    ...(noQuery ? [] : [row("Query port", `${server.ports.query}/udp`)]),
    ...(noRcon ? [] : [row("RCON port", `${server.ports.rcon}/tcp`)]),
    row("Max players", String(server.maxPlayers)),
    ...(noMods ? [] : [row("Mods", server.modIds.length ? server.modIds.join(", ") : "none")]),
    row("Cluster", server.clusterId ?? "—"),
    row("RAM limit", server.ramLimitMb ? `${server.ramLimitMb} MB` : "unset"),
  ];
  return (
    <div className="space-y-6">
      <ResourcesPanel serverId={server.id} state={server.state} />
      <div className="card">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-ark-border/50 pb-2">
              <dt className="text-slate-400">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        {isIcarus && (
          <p className="mt-3 text-xs leading-snug text-slate-500">
            The map + game mode are set in-game: players pick Olympus / Styx / Prometheus and Mission vs Open
            World when they create a <span className="text-slate-300">prospect</span> from the lobby. It resumes
            across restarts.
          </p>
        )}
        <ConnectCommand
          game={server.game}
          gamePort={server.ports.game}
          queryPort={server.ports.query}
          joinPassword={server.joinPassword}
          className="mt-4 max-w-sm"
        />
        <UnofficialListHelp
          game={server.game}
          serverName={server.name}
          mapName={mapLabel(server.map)}
          queryPort={server.ports.query}
          hasJoinPassword={Boolean(server.joinPassword)}
          defaultOpen
          className="mt-3 max-w-sm"
        />
      </div>
      <GeneralCard server={server} onSaved={onChanged} />
      <ServerAccessCard server={server} onSaved={onChanged} />
      <PortsCard server={server} onSaved={onChanged} />
      <PortForwardsCard serverId={server.id} />
      {/* File-managed access lists (Valheim/Bedrock/7DTD); RCON games use the Console. */}
      {(isValheim || isBedrock || isSdtd) && <AccessListsCard serverId={server.id} />}
    </div>
  );
}
