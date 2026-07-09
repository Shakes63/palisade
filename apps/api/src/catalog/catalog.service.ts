import { Injectable, NotFoundException } from "@nestjs/common";
import { Game, type ServerConfigValues, type SettingsCatalog } from "@ark/shared";
import { ASA_CATALOG } from "./asa.catalog";
import { ASE_CATALOG } from "./ase.catalog";
import { CONAN_CATALOG } from "./conan.catalog";
import { PALWORLD_CATALOG } from "./palworld.catalog";
import { MINECRAFT_CATALOG } from "./minecraft.catalog";
import { ICARUS_CATALOG } from "./icarus.catalog";
import { BEDROCK_CATALOG } from "./bedrock.catalog";
import { VALHEIM_CATALOG } from "./valheim.catalog";
import { SEVEN_DAYS_CATALOG } from "./seven-days.catalog";
import { ENSHROUDED_CATALOG } from "./enshrouded.catalog";
import { ZOMBOID_CATALOG } from "./zomboid.catalog";
import { VRISING_CATALOG } from "./vrising.catalog";
import { SOTF_CATALOG } from "./sotf.catalog";
import { SATISFACTORY_CATALOG } from "./satisfactory.catalog";
import { LIF_CATALOG } from "./lif.catalog";
import { serializeGameIni, serializeGameUserSettings } from "./ini-serializer";

@Injectable()
export class CatalogService {
  getCatalog(game: Game): SettingsCatalog {
    if (game === Game.ASA) return ASA_CATALOG;
    if (game === Game.ASE) return ASE_CATALOG;
    if (game === Game.CONAN) return CONAN_CATALOG;
    if (game === Game.PALWORLD) return PALWORLD_CATALOG;
    if (game === Game.MINECRAFT) return MINECRAFT_CATALOG;
    if (game === Game.ICARUS) return ICARUS_CATALOG;
    if (game === Game.BEDROCK) return BEDROCK_CATALOG;
    if (game === Game.VALHEIM) return VALHEIM_CATALOG;
    if (game === Game.SEVEN_DAYS) return SEVEN_DAYS_CATALOG;
    if (game === Game.ENSHROUDED) return ENSHROUDED_CATALOG;
    if (game === Game.ZOMBOID) return ZOMBOID_CATALOG;
    if (game === Game.VRISING) return VRISING_CATALOG;
    if (game === Game.SOTF) return SOTF_CATALOG;
    if (game === Game.SATISFACTORY) return SATISFACTORY_CATALOG;
    if (game === Game.LIF) return LIF_CATALOG;
    throw new NotFoundException(`Unknown game: ${game}`);
  }

  /** Render the two INI files for a server's config. */
  renderInis(game: Game, config: ServerConfigValues): { gameUserSettings: string; game: string } {
    const catalog = this.getCatalog(game);
    return {
      gameUserSettings: serializeGameUserSettings(catalog, config),
      game: serializeGameIni(catalog, config),
    };
  }

  /** Defaults for a fresh server (every catalog key set to its default). */
  defaultsFor(game: Game): ServerConfigValues {
    const catalog = this.getCatalog(game);
    const values: Record<string, unknown> = {};
    for (const def of catalog.settings) values[def.key] = def.default;
    return { values };
  }
}
