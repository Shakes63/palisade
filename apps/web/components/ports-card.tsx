"use client";
import { useState } from "react";
import { Network, Save, Check } from "lucide-react";
import { ServerState, INDEPENDENT_QUERY_PORT, consolePortSpec, type ServerSummary } from "@ark/shared";
import { apiPatch } from "@/lib/api";

/** Edit a stopped server's ports (the container bindings + configs re-render on the
 *  next start). Derived siblings follow the game port automatically server-side. */
export function PortsCard({ server, onSaved }: { server: ServerSummary; onSaved: () => void }) {
  const [gamePort, setGamePort] = useState(String(server.ports.game));
  const [queryPort, setQueryPort] = useState(String(server.ports.query));
  const [rconPort, setRconPort] = useState(String(server.ports.rcon));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const stopped = server.state === ServerState.Stopped || server.state === ServerState.Crashed;
  const showQuery = INDEPENDENT_QUERY_PORT.has(server.game);
  const consolePort = consolePortSpec(server.game);
  const showRcon = consolePort?.editable === true;
  const dirty =
    Number(gamePort) !== server.ports.game ||
    (showQuery && Number(queryPort) !== server.ports.query) ||
    (showRcon && Number(rconPort) !== server.ports.rcon);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const body: Record<string, number> = {};
      if (Number(gamePort) !== server.ports.game) body.gamePort = Number(gamePort);
      if (showQuery && Number(queryPort) !== server.ports.query) body.queryPort = Number(queryPort);
      if (showRcon && Number(rconPort) !== server.ports.rcon) body.rconPort = Number(rconPort);
      await apiPatch(`/servers/${server.id}`, body);
      setSaved(true);
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <Network className="h-4 w-4 text-ark-accent" />
        <h3 className="text-sm font-semibold uppercase tracking-wide text-ark-accent2">Ports</h3>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label">Game port</label>
          <input
            type="number"
            min={1024}
            max={65535}
            className="input"
            value={gamePort}
            disabled={!stopped}
            onChange={(e) => setGamePort(e.target.value)}
          />
        </div>
        {showQuery && (
          <div>
            <label className="label">Query port</label>
            <input
              type="number"
              min={1024}
              max={65535}
              className="input"
              value={queryPort}
              disabled={!stopped}
              onChange={(e) => setQueryPort(e.target.value)}
            />
          </div>
        )}
        {consolePort && server.ports.rcon > 0 && (
          <div>
            <label className="label">
              {consolePort.label}
              {consolePort.editable ? "" : " (fixed)"}
            </label>
            <input
              type="number"
              min={1024}
              max={65535}
              className="input"
              value={rconPort}
              disabled={!stopped || !consolePort.editable}
              title={consolePort.editable ? undefined : "This game's server image doesn't let this port move."}
              onChange={(e) => setRconPort(e.target.value)}
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary shrink-0 whitespace-nowrap" onClick={save} disabled={!stopped || !dirty || busy}>
          {busy ? "Saving…" : saved ? (
            <>
              <Check className="h-4 w-4 shrink-0" /> Saved
            </>
          ) : (
            <>
              <Save className="h-4 w-4 shrink-0" /> Save ports
            </>
          )}
        </button>
        <span className="text-xs text-slate-500">
          {stopped
            ? "Update your router's port-forwards to match. The Overview lists every port in use."
            : "Stop the server to change ports."}
        </span>
      </div>
    </div>
  );
}
