import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Game } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LocalPaths } from "../common/paths";

export type AccessListKey = "admins" | "whitelist" | "banned";

export interface AccessList {
  key: AccessListKey;
  label: string;
  hint: string;
  entries: string[];
}

export interface AccessLists {
  lists: AccessList[];
  /** How/when the game picks changes up (shown in the UI). */
  applyNote: string;
}

/** The games this file-based editor supports (the RCON games manage access via the
 *  Console instead: /op, /whitelist, KickPlayer, BanPlayer…). */
const SUPPORTED = new Set<Game>([Game.VALHEIM, Game.BEDROCK, Game.SEVEN_DAYS]);

/**
 * Player access lists for the games whose admin model is FILES, not console
 * commands: Valheim's adminlist/permittedlist/bannedlist.txt, Bedrock's
 * allowlist.json, and 7DTD's serveradmin.xml. Lists are read/written directly in
 * the bind-mounted instance, so they work whether the server is up or down.
 */
@Injectable()
export class AccessListsService {
  constructor(private readonly prisma: PrismaService) {}

  static supports(game: Game): boolean {
    return SUPPORTED.has(game);
  }

  private async server(id: string) {
    const s = await this.prisma.server.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("Server not found");
    if (!SUPPORTED.has(s.game as Game)) {
      throw new BadRequestException("This game manages access via the Console, not list files");
    }
    return s;
  }

  async get(id: string): Promise<AccessLists> {
    const s = await this.server(id);
    const game = s.game as Game;
    if (game === Game.VALHEIM) return this.getValheim(id);
    if (game === Game.BEDROCK) return this.getBedrock(id);
    return this.getSevenDays(id);
  }

  async put(id: string, key: AccessListKey, entries: string[]): Promise<AccessLists> {
    const s = await this.server(id);
    const game = s.game as Game;
    const clean = entries.map((e) => e.trim()).filter(Boolean);
    if (game === Game.VALHEIM) await this.putValheim(id, key, clean);
    else if (game === Game.BEDROCK) await this.putBedrock(id, key, clean);
    else await this.putSevenDays(id, key, clean);
    return this.get(id);
  }

  // ── Valheim: one-id-per-line txt files in /config ────────────────────────────
  private valheimFile(id: string, key: AccessListKey): string {
    const name =
      key === "admins" ? "adminlist.txt" : key === "whitelist" ? "permittedlist.txt" : "bannedlist.txt";
    return join(LocalPaths.instanceRoot(id), "config", name);
  }

  private async getValheim(id: string): Promise<AccessLists> {
    const read = async (key: AccessListKey) => {
      try {
        const raw = await readFile(this.valheimFile(id, key), "utf8");
        return raw
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("//"));
      } catch {
        return [];
      }
    };
    return {
      lists: [
        {
          key: "admins",
          label: "Admins",
          hint: "SteamID64 (7656…) — can use F5 console commands in-game.",
          entries: await read("admins"),
        },
        {
          key: "whitelist",
          label: "Permitted players",
          hint: "SteamID64. When NON-EMPTY, only these players can join.",
          entries: await read("whitelist"),
        },
        {
          key: "banned",
          label: "Banned",
          hint: "SteamID64 — always refused.",
          entries: await read("banned"),
        },
      ],
      applyNote: "Valheim re-reads these lists on each join attempt — no restart needed.",
    };
  }

  private async putValheim(id: string, key: AccessListKey, entries: string[]): Promise<void> {
    const file = this.valheimFile(id, key);
    await mkdir(dirname(file), { recursive: true });
    const header = "// Managed by ARK Server Manager — one SteamID64 per line\n";
    await writeFile(file, header + entries.join("\n") + (entries.length ? "\n" : ""), "utf8");
  }

  // ── Bedrock: allowlist.json (gamertags) ──────────────────────────────────────
  private bedrockAllowlist(id: string): string {
    return join(LocalPaths.instanceRoot(id), "allowlist.json");
  }

  private bedrockPermissions(id: string): string {
    return join(LocalPaths.instanceRoot(id), "permissions.json");
  }

  private async getBedrock(id: string): Promise<AccessLists> {
    let allow: string[] = [];
    try {
      const raw = JSON.parse(await readFile(this.bedrockAllowlist(id), "utf8")) as { name?: string }[];
      allow = raw.map((e) => e.name ?? "").filter(Boolean);
    } catch {
      /* missing/invalid — empty */
    }
    let ops: string[] = [];
    try {
      const raw = JSON.parse(await readFile(this.bedrockPermissions(id), "utf8")) as {
        permission?: string;
        xuid?: string;
      }[];
      ops = raw.filter((e) => e.permission === "operator").map((e) => e.xuid ?? "").filter(Boolean);
    } catch {
      /* missing/invalid — empty */
    }
    return {
      lists: [
        {
          key: "admins",
          label: "Operators",
          hint: "XUIDs (captured automatically when a player joins). Operator = full command access.",
          entries: ops,
        },
        {
          key: "whitelist",
          label: "Allow-list",
          hint: "Gamertags. Only enforced when the \u201cUse allow-list\u201d server setting is on.",
          entries: allow,
        },
      ],
      applyNote: "Bedrock reloads allowlist.json live; permissions.json applies on restart (or /permission reload).",
    };
  }

  private async putBedrock(id: string, key: AccessListKey, entries: string[]): Promise<void> {
    if (key === "admins") {
      const body = entries.map((xuid) => ({ permission: "operator", xuid }));
      await writeFile(this.bedrockPermissions(id), JSON.stringify(body, null, 2) + "\n", "utf8");
      return;
    }
    if (key !== "whitelist") throw new BadRequestException("Bedrock has the allow-list and operators here");
    const body = entries.map((name) => ({ ignoresPlayerLimit: false, name }));
    await writeFile(this.bedrockAllowlist(id), JSON.stringify(body, null, 2) + "\n", "utf8");
  }

  // ── 7 Days to Die: serveradmin.xml in the saves dir ──────────────────────────
  private sevenDaysFile(id: string): string {
    return join(LocalPaths.instanceRoot(id), "saves", "Saves", "serveradmin.xml");
  }

  /** Split "Steam_76561198…" / "EOS_0002…" / bare id into platform + userid.
   *  Bare numeric ids are assumed Steam; bare hex-ish ids are assumed EOS. */
  private sdtdEntry(raw: string): { platform: string; userid: string } {
    const m = raw.match(/^(Steam|EOS|XBL|PSN)[_:](.+)$/i);
    if (m) return { platform: m[1]!, userid: m[2]! };
    return /^\d+$/.test(raw) ? { platform: "Steam", userid: raw } : { platform: "EOS", userid: raw };
  }

  private async readSevenDays(id: string): Promise<{ admins: string[]; whitelist: string[]; banned: string[] }> {
    let xml = "";
    try {
      xml = await readFile(this.sevenDaysFile(id), "utf8");
    } catch {
      return { admins: [], whitelist: [], banned: [] };
    }
    const section = (name: string) =>
      [...(xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "").matchAll(
        /platform="([^"]*)"\s+userid="([^"]*)"/g,
      )].map((m) => `${m[1]}_${m[2]}`);
    return { admins: section("users"), whitelist: section("whitelist"), banned: section("blacklist") };
  }

  private async getSevenDays(id: string): Promise<AccessLists> {
    const { admins, whitelist, banned } = await this.readSevenDays(id);
    const hint = "Steam_7656… or EOS_… (a bare number is treated as a SteamID64).";
    return {
      lists: [
        { key: "admins", label: "Admins", hint: `${hint} Full command access (level 0).`, entries: admins },
        {
          key: "whitelist",
          label: "Whitelist",
          hint: `${hint} When NON-EMPTY, only these players (and admins) can join.`,
          entries: whitelist,
        },
        { key: "banned", label: "Banned", hint: `${hint} Banned until 9999.`, entries: banned },
      ],
      applyNote: "7 Days to Die reads serveradmin.xml at boot — restart the server to apply.",
    };
  }

  private async putSevenDays(id: string, key: AccessListKey, entries: string[]): Promise<void> {
    const current = await this.readSevenDays(id);
    const next = { ...current, [key]: entries };
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const line = (raw: string, tag: string, extra: string) => {
      const { platform, userid } = this.sdtdEntry(raw);
      return `    <${tag} platform="${esc(platform)}" userid="${esc(userid)}" ${extra}/>`;
    };
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by ARK Server Manager -->
<adminTools>
  <users>
${next.admins.map((e) => line(e, "user", 'name="" permission_level="0"')).join("\n")}
  </users>
  <whitelist>
${next.whitelist.map((e) => line(e, "user", 'name=""')).join("\n")}
  </whitelist>
  <blacklist>
${next.banned.map((e) => line(e, "blacklisted", 'name="" unbandate="9999-12-31 00:00" reason="banned"')).join("\n")}
  </blacklist>
</adminTools>
`;
    const file = this.sevenDaysFile(id);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, xml, "utf8");
  }
}
