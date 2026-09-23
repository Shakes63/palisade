import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString } from "class-validator";
import { Game, workshopAppId, curseforgeBrowse, type ModSort } from "@ark/shared";
import { CurseForgeService } from "./curseforge.service";
import { SteamService } from "./steam.service";
import { FavoritesService } from "./favorites.service";
import { ModsService } from "./mods.service";

class AddModBody {
  @IsInt() remoteId!: number;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() thumbnailUrl?: string;
}
class FavoriteBody {
  @IsEnum(Game) game!: Game;
  @IsInt() remoteId!: number;
  @IsString() name!: string;
  @IsOptional() @IsString() thumbnailUrl?: string | null;
}
class ReorderBody {
  @IsArray() order!: string[];
}
class EnabledBody {
  @IsBoolean() enabled!: boolean;
}
class PinBody {
  @IsOptional() @IsString() version?: string;
}
class SetModpackBody {
  @IsInt() projectId!: number;
  @IsString() slug!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() thumbnailUrl?: string | null;
  @IsOptional() @IsInt() fileId?: number | null;
}

@Controller()
export class ModsController {
  constructor(
    private readonly mods: ModsService,
    private readonly curseforge: CurseForgeService,
    private readonly steam: SteamService,
    private readonly favorites: FavoritesService,
  ) {}

  /** Mod browser — Steam Workshop for ASE/Conan (by app id), CurseForge for ASA
   *  (all classes) and Minecraft (Modpacks class). */
  @Get("mods/browse")
  browse(
    @Query("query") query = "",
    @Query("page") page = "0",
    @Query("game") game: Game = Game.ASA,
    @Query("sort") sort: ModSort = "relevance",
    @Query("gameVersion") gameVersion?: string,
    @Query("categoryId") categoryId?: string,
  ) {
    const appId = workshopAppId(game);
    if (appId) return this.steam.search(query, Number(page), sort, appId);
    const cf = curseforgeBrowse(game) ?? {};
    return this.curseforge.search(query, Number(page), sort, { ...cf, gameVersion, categoryId });
  }

  /** Categories for the browser's filter (CurseForge only; Workshop has none). */
  @Get("mods/categories")
  categories(@Query("game") game: Game = Game.ASA) {
    const cf = curseforgeBrowse(game);
    return cf ? this.curseforge.categories(cf.gameId) : [];
  }

  /** Whether the browser for this game has its API key set. Settings itself is
   *  admin-only, so the Mods tab asks here instead. */
  @Get("mods/key-status")
  async keyStatus(@Query("game") game: Game = Game.ASA): Promise<{ configured: boolean }> {
    const configured = workshopAppId(game) ? await this.steam.hasKey() : await this.curseforge.hasKey();
    return { configured };
  }

  // ── Favorites (global per game) ────────────────────────────────────────────
  @Get("mods/favorites")
  listFavorites(@Query("game") game: Game = Game.ASA) {
    return this.favorites.list(game);
  }

  @Post("mods/favorites")
  addFavorite(@Body() body: FavoriteBody) {
    return this.favorites.add(body.game, {
      remoteId: body.remoteId,
      name: body.name,
      thumbnailUrl: body.thumbnailUrl ?? null,
    });
  }

  @Delete("mods/favorites/:remoteId")
  removeFavorite(@Param("remoteId") remoteId: string, @Query("game") game: Game = Game.ASA) {
    return this.favorites.remove(game, Number(remoteId));
  }

  @Get("mods/:remoteId")
  details(@Param("remoteId") remoteId: string, @Query("game") game: Game = Game.ASA) {
    return workshopAppId(game)
      ? this.steam.details(Number(remoteId))
      : this.curseforge.details(Number(remoteId));
  }

  @Get("servers/:id/mods")
  list(@Param("id") id: string) {
    return this.mods.listInstalled(id);
  }

  @Post("servers/:id/mods")
  add(@Param("id") id: string, @Body() body: AddModBody) {
    return this.mods.add(id, body);
  }

  @Delete("servers/:id/mods/:modInstallId")
  remove(@Param("id") id: string, @Param("modInstallId") modInstallId: string) {
    return this.mods.remove(id, modInstallId);
  }

  @Post("servers/:id/mods/reorder")
  reorder(@Param("id") id: string, @Body() body: ReorderBody) {
    return this.mods.reorder(id, body.order);
  }

  @Patch("servers/:id/mods/:modInstallId/enabled")
  setEnabled(
    @Param("id") id: string,
    @Param("modInstallId") modInstallId: string,
    @Body() body: EnabledBody,
  ) {
    return this.mods.setEnabled(id, modInstallId, body.enabled);
  }

  @Patch("servers/:id/mods/:modInstallId/pin")
  setPin(
    @Param("id") id: string,
    @Param("modInstallId") modInstallId: string,
    @Body() body: PinBody,
  ) {
    return this.mods.setPin(id, modInstallId, body.version ?? null);
  }

  // ── Minecraft modpacks (itzg AUTO_CURSEFORGE) ──────────────────────────────
  /** The CurseForge modpack installed on a Minecraft server (or null). */
  @Get("servers/:id/minecraft/modpack")
  getModpack(@Param("id") id: string) {
    return this.mods.getMinecraftModpack(id);
  }

  /** Install a modpack — the image installs it (loader + mods) on next start. */
  @Put("servers/:id/minecraft/modpack")
  setModpack(@Param("id") id: string, @Body() body: SetModpackBody) {
    return this.mods.setMinecraftModpack(id, {
      projectId: body.projectId,
      slug: body.slug,
      name: body.name,
      thumbnailUrl: body.thumbnailUrl ?? null,
      fileId: body.fileId ?? null,
    });
  }

  /** Re-pin the modpack to CurseForge's current main file (one-click update). */
  @Post("servers/:id/minecraft/modpack/update")
  updateModpack(@Param("id") id: string) {
    return this.mods.updateMinecraftModpack(id);
  }

  /** Clear the modpack — the server reverts to the configured vanilla/flavour type. */
  @Delete("servers/:id/minecraft/modpack")
  clearModpack(@Param("id") id: string) {
    return this.mods.clearMinecraftModpack(id);
  }
}
