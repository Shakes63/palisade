import { BadRequestException, Injectable } from "@nestjs/common";
import {
  ASE_WORKSHOP_APP_ID,
  MOD_PAGE_SIZE,
  type ModDetail,
  type ModSearchResult,
  type ModSort,
} from "@ark/shared";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { stripMarkup } from "./mod-util";

const STEAM_BASE = "https://api.steampowered.com";

// EPublishedFileQueryType values. "name" has no server-side equivalent — the UI
// sorts those client-side; everything else maps to a query_type.
const STEAM_QUERY_TYPE: Record<ModSort, string> = {
  relevance: "3", // RankedByTrend (filtered by search_text)
  popularity: "3", // RankedByTrend
  downloads: "12", // RankedByTotalUniqueSubscriptions
  updated: "21", // RankedByLastUpdatedDate
  name: "3",
};

/**
 * Steam Workshop browser for ASE mods via the Steam Web API
 * (IPublishedFileService/QueryFiles, app 346110). Key stored encrypted.
 */
@Injectable()
export class SteamService {
  constructor(private readonly settings: ManagerSettingsService) {}

  async hasKey(): Promise<boolean> {
    return Boolean(await this.settings.get(SettingKeys.SteamWebApiKey));
  }

  private async key(): Promise<string> {
    const key = await this.settings.get(SettingKeys.SteamWebApiKey);
    if (!key) {
      throw new BadRequestException(
        "Steam Web API key not configured — add it in Settings to browse Workshop mods.",
      );
    }
    return key;
  }

  async search(
    query: string,
    page = 0,
    sort: ModSort = "relevance",
    appId: number = ASE_WORKSHOP_APP_ID,
  ): Promise<ModSearchResult[]> {
    const params = new URLSearchParams({
      key: await this.key(),
      appid: String(appId),
      search_text: query,
      numperpage: String(MOD_PAGE_SIZE),
      page: String(page + 1),
      query_type: STEAM_QUERY_TYPE[sort] ?? "3",
      return_metadata: "true",
      return_previews: "true",
      return_tags: "true",
      return_short_description: "true",
    });
    const res = await fetch(
      `${STEAM_BASE}/IPublishedFileService/QueryFiles/v1/?${params.toString()}`,
    );
    if (!res.ok) throw new BadRequestException(`Steam API ${res.status}: ${res.statusText}`);
    const body = (await res.json()) as { response?: { publishedfiledetails?: SteamFile[] } };
    return (body.response?.publishedfiledetails ?? []).map(toResult);
  }

  /** Full details for one Workshop item (GetPublishedFileDetails — public). */
  async details(remoteId: number): Promise<ModDetail> {
    const res = await fetch(`${STEAM_BASE}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ itemcount: "1", "publishedfileids[0]": String(remoteId) }).toString(),
    });
    if (!res.ok) throw new BadRequestException(`Steam API ${res.status}: ${res.statusText}`);
    const body = (await res.json()) as { response?: { publishedfiledetails?: SteamFile[] } };
    const f = body.response?.publishedfiledetails?.[0];
    if (!f || !f.title) throw new BadRequestException("Workshop item not found");
    return {
      ...toResult(f),
      description: stripMarkup(f.description ?? f.file_description ?? f.short_description),
      screenshots: f.preview_url ? [f.preview_url] : [],
    };
  }
}

interface SteamFile {
  publishedfileid: string;
  title?: string;
  short_description?: string;
  file_description?: string;
  description?: string;
  preview_url?: string;
  subscriptions?: number;
  lifetime_subscriptions?: number;
  time_updated?: number;
  file_size?: string | number;
  tags?: Array<{ tag?: string; display_name?: string }>;
}

function toResult(f: SteamFile): ModSearchResult {
  return {
    remoteId: Number(f.publishedfileid),
    slug: null, // Workshop items have no CurseForge-style slug
    name: f.title ?? `Workshop ${f.publishedfileid}`,
    summary: f.short_description ?? stripMarkup(f.file_description ?? f.description).slice(0, 200),
    thumbnailUrl: f.preview_url ?? null,
    downloadCount: f.lifetime_subscriptions ?? f.subscriptions ?? 0,
    authors: [],
    websiteUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${f.publishedfileid}`,
    lastUpdated: f.time_updated ? new Date(f.time_updated * 1000).toISOString() : null,
    fileSize: f.file_size != null ? Number(f.file_size) : null,
    version: null,
    categories: (f.tags ?? []).map((t) => t.display_name ?? t.tag ?? "").filter(Boolean),
    featured: false,
  };
}
