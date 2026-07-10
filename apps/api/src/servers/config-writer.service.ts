import { Injectable } from "@nestjs/common";
import { mkdir, writeFile, readFile, stat, chmod, chown } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Game, type ServerConfigValues } from "@ark/shared";
import { CryptoService } from "../crypto/crypto.service";
import { CatalogService } from "../catalog/catalog.service";
import { SERVER_UID, SERVER_GID } from "../common/images";
import { loadEnv } from "../config/env";
import {
  patchPalServerLauncher,
  renderSotfConfig,
  renderSdtdServerXml,
  patchLifWorldXml,
  patchAtsServerConfig,
  patchTShockConfig,
  patchFactorioSettings,
} from "./runtime-spec";

/** The subset of a Server row the config writers read. */
export interface ConfigWriterRow {
  id: string;
  name: string;
  game: string;
  map: string;
  maxPlayers: number;
  gamePort: number;
  rawSocketPort: number;
  queryPort: number;
  rconPort: number;
  adminPasswordEnc: string | null;
  serverPasswordEnc: string | null;
  configJson: string;
}

type ServerRow = ConfigWriterRow;

const portsOf = (s: ConfigWriterRow) => ({
  game: s.gamePort,
  rawSocket: s.rawSocketPort,
  query: s.queryPort,
  rcon: s.rconPort,
});

/**
 * Renders/patches each game's native config before a container starts. Every
 * game either (a) builds its own config from env — the no-op list at the top,
 * (b) has a bespoke render/patch branch here, or (c) falls through to the ARK
 * INI renderer at the bottom. Missing a game from the no-op list means it
 * silently gets junk ARK INIs — lifecycle.e2e.test.ts guards exactly that.
 */
@Injectable()
export class ServerConfigWriter {
  constructor(
    private readonly crypto: CryptoService,
    private readonly catalog: CatalogService,
  ) {}

  async writeInis(server: ServerRow): Promise<void> {
    if (!server) return;
    const env = loadEnv();
    const game = server.game as Game;
    // Env-driven images build their own config (Minecraft/Bedrock → server.properties,
    // Icarus → ServerSettings.ini, Valheim → launch args, Enshrouded → enshrouded_server.json,
    // V Rising → HOST/GAME_SETTINGS env patching its JSONs, Core Keeper/Rust/BeamMP →
    // pure env) — nothing to render. Anything missing from this list falls through to
    // the ARK INI renderer at the bottom and gets junk GameUserSettings.ini/Game.ini
    // files (guarded by lifecycle.e2e.test.ts).
    if (
      game === Game.MINECRAFT ||
      game === Game.ICARUS ||
      game === Game.BEDROCK ||
      game === Game.VALHEIM ||
      game === Game.ENSHROUDED ||
      game === Game.VRISING ||
      game === Game.SATISFACTORY ||
      game === Game.CORE_KEEPER ||
      game === Game.RUST ||
      game === Game.BEAMMP
    )
      return;

    // Palworld: settings come from env (thijsvanloef renders PalWorldSettings.ini), so
    // the only thing to write is the UE4SS preload. It CANNOT be a container-wide
    // LD_PRELOAD — that injects libUE4SS.so into bash/steamcmd and segfaults them — so
    // we prefix the exec line inside Steam's own PalServer.sh. SteamCMD rewrites that
    // file on update, hence re-applying (or removing) it before every start.
    if (game === Game.PALWORLD) {
      const launcher = join(env.DATA_DIR, "instances", server.id, "PalServer.sh");
      let script: string;
      try {
        script = await readFile(launcher, "utf8");
      } catch {
        return; // not installed yet — first boot writes it, and mods can't be on yet
      }
      const cfg = JSON.parse(server.configJson) as ServerConfigValues;
      const preload = cfg.values?._palFramework
        ? (cfg.values._palFrameworkPreload as string) || "Pal/Binaries/Linux/libUE4SS.so"
        : null;
      const patched = patchPalServerLauncher(script, preload);
      if (patched !== script) await writeFile(launcher, patched, { mode: 0o755 });
      return;
    }

    // Project Zomboid: the danixu86 image applies env vars by sed-ing
    // data/Server/servertest.ini — but on FIRST boot that file doesn't exist yet, so
    // none of them (RCON password, join password, display name…) would land until a
    // restart (verified live). Seed a minimal ini holding exactly the keys the
    // image's sed patches, plus MaxPlayers (which has no env var); PZ merges every
    // other default in on boot. On later starts just keep MaxPlayers in sync.
    if (game === Game.ZOMBOID) {
      const dir = join(env.DATA_DIR, "instances", server.id, "data", "Server");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "servertest.ini");
      const exists = await stat(file).then(() => true).catch(() => false);
      if (!exists) {
        const seed = [
          "PublicName=",
          "Public=false",
          "Password=",
          `MaxPlayers=${server.maxPlayers}`,
          `UDPPort=${server.rawSocketPort}`,
          `RCONPort=${server.rconPort}`,
          "RCONPassword=",
          "Mods=",
          "WorkshopItems=",
          "SteamVAC=true",
          "",
        ].join("\n");
        await writeFile(file, seed, "utf8");
      } else {
        const ini = await readFile(file, "utf8");
        const patched = /^MaxPlayers=/m.test(ini)
          ? ini.replace(/^MaxPlayers=.*$/m, `MaxPlayers=${server.maxPlayers}`)
          : `${ini}\nMaxPlayers=${server.maxPlayers}\n`;
        if (patched !== ini) await writeFile(file, patched, "utf8");
      }
      // The image's fixed steam user must be able to rewrite the file on boot.
      await chown(dir, SERVER_UID[game], SERVER_GID[game]).catch(() => undefined);
      await chown(file, SERVER_UID[game], SERVER_GID[game]).catch(() => undefined);
      return;
    }

    // Sons of the Forest: all settings live in userdata/dedicatedserver.cfg (JSON,
    // no env interface) — render it into the game bind. The jammsen entrypoint
    // chowns the whole bind to PUID/PGID on start, so root-written is fine.
    if (game === Game.SOTF) {
      const dir = join(env.DATA_DIR, "instances", server.id, "game", "userdata");
      await mkdir(dir, { recursive: true });
      const cfg = renderSotfConfig({
        sessionName: server.name,
        serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
        maxPlayers: server.maxPlayers,
        map: server.map,
        ports: portsOf(server),
        catalog: this.catalog.getCatalog(Game.SOTF),
        config: JSON.parse(server.configJson) as ServerConfigValues,
      });
      await writeFile(join(dir, "dedicatedserver.cfg"), cfg, "utf8");
      return;
    }

    // LiF:YO: all settings live in serverfiles/config/world_1.xml. The file is
    // WRITTEN BY STEAMCMD on the first install (so it can't be pre-seeded — the
    // depot would overwrite it); once present, patch our name/passwords/slots/
    // port + catalog values into it before every start, preserving the rest.
    // On the very first boot the image's own defaults apply; a restart applies ours.
    if (game === Game.LIF) {
      const file = join(env.DATA_DIR, "instances", server.id, "serverfiles", "config", "world_1.xml");
      const xml = await readFile(file, "utf8").catch(() => null);
      if (xml !== null) {
        const patched = patchLifWorldXml(xml, {
          sessionName: server.name,
          serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
          adminPassword: server.adminPasswordEnc ? this.crypto.decrypt(server.adminPasswordEnc) : "",
          maxPlayers: server.maxPlayers,
          gamePort: server.gamePort,
          catalog: this.catalog.getCatalog(Game.LIF),
          config: JSON.parse(server.configJson) as ServerConfigValues,
        });
        if (patched !== xml) await writeFile(file, patched, "utf8");
      }
      return;
    }

    // Factorio: merge server-settings.json in the config bind (the image seeds the
    // full example around our keys) and keep config/rconpw in sync with the admin
    // password — the image only generates a random one when the file is missing.
    if (game === Game.FACTORIO) {
      const dir = join(env.DATA_DIR, "instances", server.id, "data", "config");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "server-settings.json");
      const existing = await readFile(file, "utf8").catch(() => null);
      const patched = patchFactorioSettings(existing, {
        sessionName: server.name,
        serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
        maxPlayers: server.maxPlayers,
        catalog: this.catalog.getCatalog(Game.FACTORIO),
        config: JSON.parse(server.configJson) as ServerConfigValues,
      });
      if (patched !== existing) await writeFile(file, patched, "utf8");
      if (server.adminPasswordEnc) {
        await writeFile(join(dir, "rconpw"), this.crypto.decrypt(server.adminPasswordEnc), "utf8");
      }
      return;
    }

    // Terraria: TShock's config.json lives in the worlds bind (CONFIGPATH). Merge
    // our first-class fields + catalog keys into it before every start; TShock
    // fills in / rewrites all its other defaults on boot.
    if (game === Game.TERRARIA) {
      const dir = join(env.DATA_DIR, "instances", server.id, "worlds");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "config.json");
      const existing = await readFile(file, "utf8").catch(() => null);
      const patched = patchTShockConfig(existing, {
        sessionName: server.name,
        serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
        adminPassword: server.adminPasswordEnc ? this.crypto.decrypt(server.adminPasswordEnc) : "",
        maxPlayers: server.maxPlayers,
        gamePort: server.gamePort,
        restPort: server.rconPort,
        catalog: this.catalog.getCatalog(Game.TERRARIA),
        config: JSON.parse(server.configJson) as ServerConfigValues,
      });
      if (patched !== existing) await writeFile(file, patched, "utf8");
      return;
    }

    // ATS/ETS2: settings live in server_config.sii inside the game's save dir. The
    // ich777 image seeds it (with the bundled server_packages world export) on
    // FIRST boot only — so it can't be pre-written; once present, patch our
    // lobby name/password/slots/ports + catalog values before every start.
    if (game === Game.ATS || game === Game.ETS2) {
      const file = join(
        env.DATA_DIR,
        "instances",
        server.id,
        "serverfiles",
        ".local",
        "share",
        game === Game.ATS ? "American Truck Simulator" : "Euro Truck Simulator 2",
        "server_config.sii",
      );
      const sii = await readFile(file, "utf8").catch(() => null);
      if (sii !== null) {
        const patched = patchAtsServerConfig(sii, {
          sessionName: server.name,
          serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
          maxPlayers: server.maxPlayers,
          gamePort: server.gamePort,
          queryPort: server.queryPort,
          catalog: this.catalog.getCatalog(game),
          config: JSON.parse(server.configJson) as ServerConfigValues,
        });
        if (patched !== sii) await writeFile(file, patched, "utf8");
      }
      return;
    }

    // 7 Days to Die's settings live in sdtdserver.xml (not env vars) — render it into
    // the serverfiles bind. The vinanrra image chowns the mounts to PUID/PGID on
    // startup, so a root-written file becomes readable to the runtime user.
    if (game === Game.SEVEN_DAYS) {
      const dir = join(env.DATA_DIR, "instances", server.id, "serverfiles");
      await mkdir(dir, { recursive: true });
      const xml = renderSdtdServerXml({
        sessionName: server.name,
        serverPassword: server.serverPasswordEnc ? this.crypto.decrypt(server.serverPasswordEnc) : "",
        adminPassword: server.adminPasswordEnc ? this.crypto.decrypt(server.adminPasswordEnc) : "changeme",
        maxPlayers: server.maxPlayers,
        map: server.map,
        gamePort: server.gamePort,
        telnetPort: server.rconPort,
        catalog: this.catalog.getCatalog(Game.SEVEN_DAYS),
        config: JSON.parse(server.configJson) as ServerConfigValues,
      });
      await writeFile(join(dir, "sdtdserver.xml"), xml, "utf8");
      return;
    }

    const base = join(env.DATA_DIR, "instances", server.id);
    // Both images bind the instance dir as their data root. ASA (POK) installs
    // at the root → config under ShooterGame/Saved/Config/WindowsServer; ASE
    // (hermsi) installs under server/ → ShooterGame/Saved/Config/LinuxServer.
    const dir =
      game === Game.ASA
        ? join(base, "ShooterGame", "Saved", "Config", "WindowsServer")
        : join(base, "server", "ShooterGame", "Saved", "Config", "LinuxServer");
    await mkdir(dir, { recursive: true });
    const { gameUserSettings, game: gameIni } = this.catalog.renderInis(
      game,
      JSON.parse(server.configJson) as ServerConfigValues,
    );
    await writeFile(join(dir, "GameUserSettings.ini"), gameUserSettings, "utf8");
    await writeFile(join(dir, "Game.ini"), gameIni, "utf8");
    // The images run as a fixed non-root user and write throughout the data dir
    // (POK creates Saved/SavedArks + Saved/Logs and edits the INIs in place). We
    // create the config path as root, so chown the WHOLE chain from the instance
    // root down to the config dir — otherwise the runtime user can't create its
    // own subdirs under our root-owned Saved/Config parents.
    const chain = [base];
    let cur = base;
    for (const seg of relative(base, dir).split(sep)) {
      cur = join(cur, seg);
      chain.push(cur);
    }
    await this.makeServerWritable(
      game,
      ...chain,
      join(dir, "GameUserSettings.ini"),
      join(dir, "Game.ini"),
    );
  }
  /**
   * Make paths writable by a game image's fixed runtime uid/gid (POK=7777,
   * hermsi=1000) — neither fully chowns the dirs the manager injects. Best-effort:
   * chown needs the manager to run as root (true in the deployed container, a
   * harmless no-op in local dev).
   */
  private async makeServerWritable(game: Game, ...paths: string[]): Promise<void> {
    for (const p of paths) {
      await chmod(p, 0o775).catch(() => undefined);
      await chown(p, SERVER_UID[game], SERVER_GID[game]).catch(() => undefined);
    }
  }

}
