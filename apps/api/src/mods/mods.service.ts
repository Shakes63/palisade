import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Game, EventType, type ServerConfigValues, type MinecraftModpack } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { CurseForgeService } from "./curseforge.service";

export interface AddModInput {
  remoteId: number;
  name?: string;
  thumbnailUrl?: string | null;
}

/**
 * Per-server mod management. The launch builder reads `server.modIds`, so this
 * service keeps that array in sync with the enabled ModInstalls (in load order)
 * while ModInstall/Mod hold the metadata, order, pin, and enabled flag.
 */
@Injectable()
export class ModsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly settings: ManagerSettingsService,
    private readonly curseforge: CurseForgeService,
  ) {}

  async listInstalled(serverId: string) {
    return this.prisma.modInstall.findMany({
      where: { serverId },
      include: { mod: true },
      orderBy: { loadOrder: "asc" },
    });
  }

  async add(serverId: string, input: AddModInput) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    const source = (server.game as Game) === Game.ASA ? "curseforge" : "workshop";

    const mod = await this.prisma.mod.upsert({
      where: {
        game_source_remoteId: { game: server.game, source, remoteId: String(input.remoteId) },
      },
      create: {
        game: server.game,
        source,
        remoteId: String(input.remoteId),
        name: input.name ?? `Mod ${input.remoteId}`,
        thumbnailUrl: input.thumbnailUrl ?? null,
      },
      update: input.name ? { name: input.name, thumbnailUrl: input.thumbnailUrl ?? null } : {},
    });

    const existing = await this.prisma.modInstall.findUnique({
      where: { serverId_modId: { serverId, modId: mod.id } },
    });
    if (existing) throw new BadRequestException("Mod already installed on this server");

    const max = await this.prisma.modInstall.aggregate({
      where: { serverId },
      _max: { loadOrder: true },
    });
    await this.prisma.modInstall.create({
      data: { serverId, modId: mod.id, loadOrder: (max._max.loadOrder ?? 0) + 1 },
    });
    await this.sync(serverId);
    await this.events.emit({
      type: EventType.ConfigChanged,
      message: `Added mod ${mod.name} (${input.remoteId})`,
      serverId,
    });
    return this.listInstalled(serverId);
  }

  async remove(serverId: string, modInstallId: string) {
    await this.prisma.modInstall.delete({ where: { id: modInstallId } });
    await this.sync(serverId);
    return this.listInstalled(serverId);
  }

  async setEnabled(serverId: string, modInstallId: string, enabled: boolean) {
    await this.prisma.modInstall.update({ where: { id: modInstallId }, data: { enabled } });
    await this.sync(serverId);
    return this.listInstalled(serverId);
  }

  async setPin(serverId: string, modInstallId: string, version: string | null) {
    await this.prisma.modInstall.update({
      where: { id: modInstallId },
      data: { pinnedVersion: version },
    });
    return this.listInstalled(serverId);
  }

  /** Reorder by an explicit list of ModInstall ids (load order matters in ARK). */
  async reorder(serverId: string, orderedIds: string[]) {
    await this.prisma.$transaction(
      orderedIds.map((id, idx) =>
        this.prisma.modInstall.update({ where: { id }, data: { loadOrder: idx + 1 } }),
      ),
    );
    await this.sync(serverId);
    return this.listInstalled(serverId);
  }

  // ── Minecraft modpacks (itzg AUTO_CURSEFORGE) ──────────────────────────────
  // A Minecraft server runs ONE CurseForge modpack (vs ARK's mod list). It's stored
  // as underscore-prefixed config values and consumed by the runtime spec, which
  // switches the image to AUTO_CURSEFORGE. These read/write those values.

  /** The installed modpack for a Minecraft server, or null. */
  async getMinecraftModpack(serverId: string): Promise<MinecraftModpack | null> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    const values = (JSON.parse(server.configJson) as ServerConfigValues).values ?? {};
    const slug = values["_mcModpackSlug"];
    if (typeof slug !== "string" || !slug) return null;
    return {
      projectId: Number(values["_mcModpackProjectId"]) || 0,
      slug,
      name: typeof values["_mcModpackName"] === "string" ? values["_mcModpackName"] : slug,
      thumbnailUrl: typeof values["_mcModpackThumb"] === "string" ? values["_mcModpackThumb"] : null,
      fileId: values["_mcModpackFileId"] != null ? Number(values["_mcModpackFileId"]) : null,
    };
  }

  /** Install a modpack: persist it + flag a restart. itzg downloads it on next start. */
  async setMinecraftModpack(serverId: string, pack: MinecraftModpack): Promise<MinecraftModpack> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    if ((server.game as Game) !== Game.MINECRAFT)
      throw new BadRequestException("Modpacks are Minecraft-only");
    // The image downloads the pack itself using the user's CurseForge API key.
    const key = await this.settings.get(SettingKeys.CurseForgeApiKey);
    if (!key)
      throw new BadRequestException(
        "Add your CurseForge API key in Settings before installing a modpack.",
      );
    // Reject packs whose author blocked third-party downloads up front, so the user
    // gets a clear message now instead of a mysterious Crashed when itzg can't fetch it.
    const dist = await this.curseforge.checkDistributable(pack.projectId);
    if (!dist.ok) throw new BadRequestException(dist.reason);
    await this.writeModpackValues(server.id, server.configJson, {
      _mcModpackSlug: pack.slug,
      _mcModpackProjectId: pack.projectId,
      _mcModpackName: pack.name,
      _mcModpackThumb: pack.thumbnailUrl,
      _mcModpackFileId: pack.fileId,
    });
    await this.events.emit({
      type: EventType.ConfigChanged,
      message: `Set modpack: ${pack.name}`,
      serverId,
    });
    return (await this.getMinecraftModpack(serverId))!;
  }

  /** Remove the modpack — the server reverts to its configured vanilla/flavour type. */
  async clearMinecraftModpack(serverId: string): Promise<{ ok: true }> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    await this.writeModpackValues(server.id, server.configJson, {
      _mcModpackSlug: undefined,
      _mcModpackProjectId: undefined,
      _mcModpackName: undefined,
      _mcModpackThumb: undefined,
      _mcModpackFileId: undefined,
    });
    await this.events.emit({ type: EventType.ConfigChanged, message: "Cleared modpack", serverId });
    return { ok: true };
  }

  /** Merge modpack keys into the server config (undefined deletes a key) + flag restart. */
  private async writeModpackValues(
    serverId: string,
    configJson: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const config = JSON.parse(configJson) as ServerConfigValues;
    const values = { ...(config.values ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete values[k];
      else values[k] = v;
    }
    config.values = values;
    await this.prisma.server.update({
      where: { id: serverId },
      data: { configJson: JSON.stringify(config), configDirty: true },
    });
  }

  /** Recompute server.modIds = enabled installs, in load order. */
  private async sync(serverId: string): Promise<void> {
    const installs = await this.prisma.modInstall.findMany({
      where: { serverId, enabled: true },
      include: { mod: true },
      orderBy: { loadOrder: "asc" },
    });
    const ids = installs.map((i) => Number(i.mod.remoteId)).filter((n) => !Number.isNaN(n));
    await this.prisma.server.update({
      where: { id: serverId },
      // configDirty: mod changes (add/remove/enable/disable/reorder) alter the
      // launch line, so flag a restart on a running server just like settings do.
      data: { modIds: JSON.stringify(ids), configDirty: true },
    });
  }
}
