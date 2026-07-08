"use client";
import { useState } from "react";
import { Network, Save, Check } from "lucide-react";
import { Game, ServerState, type ServerSummary } from "@ark/shared";
import { apiPatch } from "@/lib/api";

/** Games whose query port is a real, independently-configurable port. Valheim and
 *  7DTD derive theirs from the game port (so only the game port is editable);
 *  Minecraft/Bedrock have none. */
const INDEPENDENT_QUERY = new Set<Game>([Game.ASA, Game.ASE, Game.CONAN, Game.ICARUS, Game.ENSHROUDED]);
/** Games with an editable remote-console port (Source RCON, or telnet for 7DTD). */
const HAS_RCON_PORT = new Set<Game>([
  Game.ASA,
  Game.ASE,
  Game.CONAN,
  Game.PALWORLD,
  Game.MINECRAFT,
  Game.SEVEN_DAYS,
]);

/** Edit a stopped server's ports (the container bindings + configs re-render on the
 *  next start). Derived siblings (raw socket; Valheim/7DTD query) follow the game
 *  port automatically server-side. */
export function PortsCard({ server, onSaved }: { server: ServerSummary; onSaved: () => void }) {
  const [gamePort, setGamePort] = useState(String(server.ports.game));
  const [queryPort, setQueryPort] = useState(String(server.ports.query));
  const [rconPort, setRconPort] = useState(String(server.ports.rcon));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const stopped = server.state === ServerState.Stopped || server.state === ServerState.Crashed;
  const showQuery = INDEPENDENT_QUERY.has(server.game);
  const showRcon = HAS_RCON_PORT.has(server.game);
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
        {showRcon && (
          <div>
            <label className="label">{server.game === Game.SEVEN_DAYS ? "Telnet port" : "RCON port"}</label>
            <input
              type="number"
              min={1024}
              max={65535}
              className="input"
              value={rconPort}
              disabled={!stopped}
              onChange={(e) => setRconPort(e.target.value)}
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={!stopped || !dirty || busy}>
          {busy ? "Saving…" : saved ? (
            <>
              <Check className="h-4 w-4" /> Saved
            </>
          ) : (
            <>
              <Save className="h-4 w-4" /> Save ports
            </>
          )}
        </button>
        <span className="text-xs text-slate-500">
          {stopped
            ? "Derived ports (raw socket; Valheim/7DTD query) follow the game port. Update your router's port-forwards to match."
            : "Stop the server to change ports."}
        </span>
      </div>
    </div>
  );
}
