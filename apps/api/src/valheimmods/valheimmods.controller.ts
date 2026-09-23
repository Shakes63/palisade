import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ValheimModsService } from "./valheimmods.service";

@Controller("servers/:id/valheimmods")
export class ValheimModsController {
  constructor(private readonly valheimmods: ValheimModsService) {}

  /** Installed mod folders under config/bepinex/plugins. */
  @Get()
  status(@Param("id") id: string) {
    return this.valheimmods.status(id);
  }

  /** Search the merged Thunderstore + Hexium Valheim package index. */
  @Get("search")
  search(@Query("q") q = "", @Query("page") page = "0") {
    return this.valheimmods.search(q, Math.max(0, Number(page) || 0));
  }

  /** Install a package (by "Owner-ModName") + its dependencies. */
  @Post("install")
  install(@Param("id") id: string, @Body() body: { fullName: string }) {
    return this.valheimmods.install(id, body.fullName);
  }

  @Delete("mods/:name")
  remove(@Param("id") id: string, @Param("name") name: string) {
    return this.valheimmods.remove(id, name);
  }
}
