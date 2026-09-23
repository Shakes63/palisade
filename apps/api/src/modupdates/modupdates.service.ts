import { Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import * as cron from "node-cron";
import {
  Game,
  EventType,
  ServerState,
  type ModUpdateStatus,
  type ModUpdateResult,
} from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { ValheimModsService } from "../valheimmods/valheimmods.service";
import { ModsService } from "../mods/mods.service";

// Every 6 hours, offset off the top of the hour. Mod authors publish far less often
// than the game itself updates, so this is plenty without hammering Thunderstore/CF.
const POLL_CRON = "43 */6 * * *";
const INITIAL_DELAY_MS = 45_000; // let the app settle before the first sweep

/**
 * Games whose mods do NOT auto-update on restart AND expose a remote version to
 * compare against — the only ones a mod updater can meaningfully serve. Workshop/
 * CurseForge-list games redownload mods on every start (nothing to check), and the
 * file-upload games (Palworld/Icarus/7DTD/Bedrock) have no remote source or version.
 */
export const MOD_UPDATE_GAMES: ReadonlySet<Game> = new Set<Game>([Game.VALHEIM, Game.MINECRAFT]);

/**
 * The mod updater. Mirrors UpdatesService (which does this for Steam server builds):
 * a periodic poll flags servers whose installed mods are behind their source and
 * emits a ModUpdateAvailable event (forwarded to Discord/ntfy). `status` answers
 * on-demand; `updateAll` applies every pending update in one shot (the files/config
 * change on disk — the caller restarts to load them).
 */
@Injectable()
export class ModUpdatesService implements OnModuleInit {
  private readonly logger = new Logger(ModUpdatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly valheim: ValheimModsService,
    private readonly mods: ModsService,
  ) {}

  onModuleInit(): void {
    cron.schedule(POLL_CRON, () => void this.checkAll());
    setTimeout(() => void this.checkAll(), INITIAL_DELAY_MS).unref?.();
  }

  /** Pending mod updates for one server (on-demand). Never throws — a source hiccup
   *  returns count:0 rather than failing the caller. */
  async status(serverId: string): Promise<ModUpdateStatus> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    const game = server.game as Game;
    if (!MOD_UPDATE_GAMES.has(game)) return { supported: false, count: 0, items: [] };
    try {
      if (game === Game.VALHEIM) {
        const { mods } = await this.valheim.status(serverId);
        const items = mods
          .filter((m) => m.updateAvailable)
          .map((m) => ({
            id: m.name,
            name: m.name,
            installedVersion: m.installedVersion,
            latestVersion: m.latestVersion,
          }));
        return { supported: true, count: items.length, items };
      }
      // Minecraft: a single pinned CurseForge modpack.
      const pack = await this.mods.getMinecraftModpack(serverId);
      if (pack?.updateAvailable) {
        return {
          supported: true,
          count: 1,
          items: [
            {
              id: pack.slug,
              name: pack.name,
              installedVersion: pack.fileId != null ? String(pack.fileId) : null,
              latestVersion: pack.latestFileId != null ? String(pack.latestFileId) : null,
            },
          ],
        };
      }
      return { supported: true, count: 0, items: [] };
    } catch (e) {
      this.logger.debug(`mod status(${serverId}) failed: ${(e as Error).message}`);
      return { supported: true, count: 0, items: [] };
    }
  }

  /** Apply every pending mod update for one server. Best-effort per mod (one failure
   *  doesn't abort the rest). The changes land on disk/config; `restartNeeded` says
   *  whether the server was up and so must be restarted to load them. */
  async updateAll(serverId: string): Promise<ModUpdateResult> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    const game = server.game as Game;
    const wasUp = [ServerState.Running, ServerState.Starting].includes(server.state as ServerState);
    const updated: string[] = [];
    const failed: { name: string; error: string }[] = [];

    if (game === Game.VALHEIM) {
      const { mods } = await this.valheim.status(serverId);
      for (const m of mods.filter((x) => x.updateAvailable)) {
        try {
          await this.valheim.install(serverId, m.name); // re-downloads the latest over it
          updated.push(m.name);
        } catch (e) {
          failed.push({ name: m.name, error: (e as Error).message });
        }
      }
    } else if (game === Game.MINECRAFT) {
      try {
        const pack = await this.mods.getMinecraftModpack(serverId);
        if (pack?.updateAvailable) {
          await this.mods.updateMinecraftModpack(serverId); // re-pins to the latest CF file
          updated.push(pack.name);
        }
      } catch (e) {
        failed.push({ name: "modpack", error: (e as Error).message });
      }
    }

    await this.refreshFlag(serverId).catch(() => undefined);
    if (updated.length) {
      await this.events.emit({
        type: EventType.ConfigChanged,
        message:
          `Updated ${updated.length} mod${updated.length === 1 ? "" : "s"}: ${updated.join(", ")}` +
          (wasUp ? " — restart to load them" : ""),
        serverId,
      });
    }
    return { updated, failed, restartNeeded: wasUp && updated.length > 0 };
  }

  /** The background sweep: refresh the flag for every mod-capable server. */
  async checkAll(): Promise<void> {
    try {
      const servers = await this.prisma.server.findMany({
        where: { game: { in: [...MOD_UPDATE_GAMES] } },
      });
      for (const s of servers) await this.refreshFlag(s.id).catch(() => undefined);
    } catch (e) {
      this.logger.warn(`mod update check failed: ${(e as Error).message}`);
    }
  }

  /** Recompute + persist `modUpdateAvailable`; emit ModUpdateAvailable on false→true
   *  only (so a standing update doesn't re-notify every 6-hour sweep). */
  private async refreshFlag(serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) return;
    const { count } = await this.status(serverId);
    const now = count > 0;
    if (now !== server.modUpdateAvailable) {
      await this.prisma.server
        .update({ where: { id: serverId }, data: { modUpdateAvailable: now } })
        .catch(() => undefined);
    }
    if (now && !server.modUpdateAvailable) {
      await this.events.emit({
        type: EventType.ModUpdateAvailable,
        message: `Mod update${count === 1 ? "" : "s"} available for "${server.name}" (${count}) — update from the Mods tab.`,
        serverId,
        data: { count: String(count) },
      });
    }
  }
}
