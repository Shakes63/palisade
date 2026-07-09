import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { Game, ServerState } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RconService } from "../rcon/rcon.service";
import { LogCaptureService } from "../logs/log-capture.service";
import { AccessListsService, type AccessListKey } from "../accesslists/accesslists.service";

const POLL_MS = 60_000;
/** How recent a sighting must be to be shown as "online" (poll cadence + slack). */
const ONLINE_WINDOW_MS = 90_000;

export type PlayerAction =
  | "kick"
  | "ban"
  | "whitelist"
  | "admin";

export interface SeenPlayer {
  name: string;
  playerId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  online: boolean;
}

export interface PlayersView {
  players: SeenPlayer[];
  /** Actions this game supports (drives the UI's buttons). */
  supportedActions: PlayerAction[];
  /** How sightings are captured for this game (shown as a hint). */
  captureNote: string;
}

/** Games whose player list is polled over RCON/telnet (needs the admin password). */
const RCON_POLL_GAMES = new Set<Game>([
  Game.ASA,
  Game.ASE,
  Game.CONAN,
  Game.PALWORLD,
  Game.MINECRAFT,
  Game.SEVEN_DAYS,
  Game.ZOMBOID,
]);

const ACTIONS_BY_GAME: Record<Game, PlayerAction[]> = {
  [Game.ASA]: ["kick", "ban"],
  [Game.ASE]: ["kick", "ban"],
  [Game.CONAN]: ["kick", "ban"],
  [Game.PALWORLD]: ["kick", "ban"],
  [Game.MINECRAFT]: ["kick", "ban", "whitelist", "admin"],
  [Game.ICARUS]: [], // capture-only (admin is the in-game /AdminLogin password)
  [Game.BEDROCK]: ["whitelist", "admin"],
  [Game.VALHEIM]: ["ban", "whitelist", "admin"],
  [Game.SEVEN_DAYS]: ["kick", "ban", "whitelist", "admin"],
  [Game.ENSHROUDED]: [], // no console + role passwords instead of per-player perms
  [Game.ZOMBOID]: ["kick", "ban", "admin"], // RCON: kickuser / banuser / setaccesslevel
  [Game.VRISING]: [], // RCON has no player/kick/ban commands (announce/shutdown only)
  [Game.SOTF]: [], // no console; admins are the ownerswhitelist.txt file
  [Game.SATISFACTORY]: [], // no console; management is in-game via the claimed admin password
  [Game.LIF]: [], // no console; admin is the in-game GM password
};

const CAPTURE_NOTES: Partial<Record<Game, string>> = {
  [Game.ICARUS]: "Captured from join log lines (name only).",
  [Game.BEDROCK]: "Captured from join log lines (gamertag + XUID).",
  [Game.VALHEIM]: "Captured from join log lines (character name + SteamID64).",
  [Game.ENSHROUDED]: "Captured from join log lines when the server prints them.",
  [Game.MINECRAFT]: "Captured from the live player list + join log lines.",
};

/**
 * Who has played on each server. Sightings come from two directions:
 * - a 60 s RCON/telnet player-list poll on the games that have one, and
 * - join-line parsing of the live container logs for the rest (Bedrock prints
 *   gamertag+XUID, Valheim prints SteamID64 handshakes followed by the character
 *   name, Minecraft/7DTD/Icarus print joins too).
 * Each (server, name) is upserted with first/last-seen and the platform id when
 * the game exposes one — exactly what the per-game access lists need. Actions
 * (kick/ban/whitelist/admin) dispatch to RCON commands or the access-list files,
 * whichever the game uses.
 */
@Injectable()
export class SightingsService implements OnModuleInit {
  private readonly logger = new Logger(SightingsService.name);
  /** serverId → game, refreshed each poll (used by the hot log-line parser). */
  private gameCache = new Map<string, Game>();
  /** Valheim pairs a SteamID handshake line with the next character-name line. */
  private readonly valheimPendingId = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rcon: RconService,
    private readonly logCapture: LogCaptureService,
    private readonly accessLists: AccessListsService,
  ) {}

  onModuleInit(): void {
    this.logCapture.onLine((serverId, line) => this.parseLine(serverId, line));
    setInterval(() => void this.poll(), POLL_MS).unref?.();
    void this.refreshGameCache();
  }

  // ── Capture: RCON poll ────────────────────────────────────────────────────────
  private async refreshGameCache(): Promise<void> {
    const rows = await this.prisma.server.findMany({ select: { id: true, game: true } }).catch(() => []);
    this.gameCache = new Map(rows.map((r) => [r.id, r.game as Game]));
  }

  private async poll(): Promise<void> {
    await this.refreshGameCache();
    const running = await this.prisma.server
      .findMany({ where: { state: ServerState.Running } })
      .catch(() => []);
    for (const s of running) {
      const game = s.game as Game;
      if (!RCON_POLL_GAMES.has(game) || !s.adminPasswordEnc) continue;
      try {
        const players = await this.listDetailed(s.id, game);
        for (const p of players) await this.upsert(s.id, p.name, p.playerId);
      } catch {
        /* rcon down/booting — the next poll retries */
      }
    }
  }

  /** Names + platform ids from the game's own player-list command. */
  private async listDetailed(serverId: string, game: Game): Promise<{ name: string; playerId?: string }[]> {
    if (game === Game.PALWORLD) {
      const out = await this.rcon.exec(serverId, "ShowPlayers");
      const players: { name: string; playerId?: string }[] = [];
      for (const l of out.split("\n").slice(1)) {
        const [name, , steamid] = l.split(",").map((x) => x?.trim());
        if (name) players.push({ name, playerId: steamid || undefined });
      }
      return players;
    }
    if (game === Game.MINECRAFT || game === Game.ZOMBOID) {
      // Zomboid's `players` output is name-only ("-name" lines) — no platform id.
      const names = await this.rcon.listPlayers(serverId);
      return names.map((name) => ({ name }));
    }
    if (game === Game.SEVEN_DAYS) {
      const out = await this.rcon.exec(serverId, "listplayers");
      return [...out.matchAll(/^\s*\d+\.\s*id=\S+?,\s*([^,]+?),.*?pltfmid=([^,\s]+)/gim)].map((m) => ({
        name: m[1]!.trim(),
        playerId: m[2],
      }));
    }
    if (game === Game.CONAN) {
      const out = await this.rcon.exec(serverId, "ListPlayers");
      // "idx | charName | playerName | userId | platformId | platformName"
      return out
        .split("\n")
        .map((l) => l.match(/^\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|.*?(\d{15,})?\s*$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => ({ name: (m[2] || m[1])!.trim(), playerId: m[3] }));
    }
    // ARK family: "N. Name, <eos/steam id>"
    const out = await this.rcon.exec(serverId, "ListPlayers");
    return [...out.matchAll(/^\s*\d+\.\s*(.+?),\s*([0-9a-f]{8,})\s*$/gim)].map((m) => ({
      name: m[1]!.trim(),
      playerId: m[2],
    }));
  }

  // ── Capture: log-line parsing (the no-RCON games + extra coverage) ───────────
  private parseLine(serverId: string, line: string): void {
    const game = this.gameCache.get(serverId);
    if (!game) return;
    if (game === Game.BEDROCK) {
      const m = line.match(/Player connected:\s*(.+?),\s*xuid:\s*(\d+)/i);
      if (m) void this.upsert(serverId, m[1]!.trim(), m[2]);
      return;
    }
    if (game === Game.VALHEIM) {
      const hs = line.match(/Got handshake from client (\d{10,})/i);
      if (hs) {
        this.valheimPendingId.set(serverId, hs[1]!);
        return;
      }
      const zdoid = line.match(/Got character ZDOID from ([^\s:]+)\s*:/i);
      if (zdoid) {
        const id = this.valheimPendingId.get(serverId);
        this.valheimPendingId.delete(serverId);
        void this.upsert(serverId, zdoid[1]!, id);
      }
      return;
    }
    if (game === Game.MINECRAFT) {
      const m = line.match(/:\s([A-Za-z0-9_]{2,16}) joined the game/);
      if (m) void this.upsert(serverId, m[1]!);
      return;
    }
    if (game === Game.SEVEN_DAYS) {
      const m = line.match(/Player connected.*?name='([^']+)'.*?pltfmid=([^,\s']+)/i);
      if (m) void this.upsert(serverId, m[1]!, m[2]);
      return;
    }
    if (game === Game.ICARUS) {
      const m = line.match(/Join request:[^?\n]*\?Name=([^?&\s]+)/i);
      if (m) void this.upsert(serverId, decodeURIComponent(m[1]!));
      return;
    }
    if (game === Game.ENSHROUDED) {
      const m = line.match(/Player '([^']+)' (?:joined|logged in|connected)/i);
      if (m) void this.upsert(serverId, m[1]!);
    }
  }

  private async upsert(serverId: string, name: string, playerId?: string): Promise<void> {
    if (!name) return;
    await this.prisma.playerSighting
      .upsert({
        where: { serverId_name: { serverId, name } },
        create: { serverId, name, playerId: playerId ?? null },
        // Never blank out a known platform id with a later id-less sighting.
        update: { lastSeenAt: new Date(), ...(playerId ? { playerId } : {}) },
      })
      .catch(() => undefined); // e.g. server deleted mid-flight
  }

  // ── Read + act ────────────────────────────────────────────────────────────────
  async view(serverId: string): Promise<PlayersView> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    const game = server.game as Game;
    const rows = await this.prisma.playerSighting.findMany({
      where: { serverId },
      orderBy: { lastSeenAt: "desc" },
    });
    const running = server.state === ServerState.Running;
    return {
      players: rows.map((r) => ({
        name: r.name,
        playerId: r.playerId,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        online: running && Date.now() - r.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
      })),
      supportedActions: ACTIONS_BY_GAME[game],
      captureNote:
        CAPTURE_NOTES[game] ??
        "Captured from the live player list every minute while the server runs.",
    };
  }

  /** Apply an action to a player, using whatever mechanism the game has. */
  async act(serverId: string, name: string, action: PlayerAction): Promise<{ ok: true; detail: string }> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("Server not found");
    const game = server.game as Game;
    if (!ACTIONS_BY_GAME[game].includes(action)) {
      throw new BadRequestException(`${action} isn't supported for this game`);
    }
    const sighting = await this.prisma.playerSighting.findUnique({
      where: { serverId_name: { serverId, name } },
    });
    const playerId = sighting?.playerId ?? null;

    // File-based access-list games → add to the right list (removal via the card).
    if (game === Game.VALHEIM || game === Game.BEDROCK || (game === Game.SEVEN_DAYS && action !== "kick")) {
      const key: AccessListKey =
        action === "admin" ? "admins" : action === "whitelist" ? "whitelist" : "banned";
      const entry = this.listEntryFor(game, name, playerId, action);
      const lists = await this.accessLists.get(serverId);
      const current = lists.lists.find((l) => l.key === key);
      if (!current) throw new BadRequestException(`This game has no ${key} list`);
      if (current.entries.includes(entry)) return { ok: true, detail: `${entry} is already on ${key}` };
      await this.accessLists.put(serverId, key, [...current.entries, entry]);
      // 7DTD can also apply the ban live over telnet (the file applies on restart).
      if (game === Game.SEVEN_DAYS && action === "ban" && server.state === ServerState.Running) {
        await this.rcon.ban(serverId, name).catch(() => undefined);
      }
      return { ok: true, detail: `${entry} added to ${key}` };
    }

    // RCON games → live commands.
    if (action === "kick") {
      await this.rcon.kick(serverId, this.rconSubject(game, name, playerId));
      return { ok: true, detail: `Kicked ${name}` };
    }
    if (action === "ban") {
      await this.rcon.ban(serverId, this.rconSubject(game, name, playerId));
      return { ok: true, detail: `Banned ${name}` };
    }
    if (game === Game.MINECRAFT && action === "whitelist") {
      await this.rcon.exec(serverId, `whitelist add ${name}`);
      return { ok: true, detail: `${name} whitelisted` };
    }
    if (game === Game.MINECRAFT && action === "admin") {
      await this.rcon.exec(serverId, `op ${name}`);
      return { ok: true, detail: `${name} opped` };
    }
    if (game === Game.ZOMBOID && action === "admin") {
      await this.rcon.exec(serverId, `setaccesslevel "${name}" admin`);
      return { ok: true, detail: `${name} is now an admin` };
    }
    throw new BadRequestException(`${action} isn't supported for this game`);
  }

  /** The access-list entry format each game expects. */
  private listEntryFor(game: Game, name: string, playerId: string | null, action: PlayerAction): string {
    if (game === Game.VALHEIM) {
      if (!playerId) {
        throw new BadRequestException(
          `No SteamID captured for ${name} yet — Valheim's lists need the id (it's captured when they join).`,
        );
      }
      return playerId;
    }
    if (game === Game.BEDROCK) {
      if (action === "whitelist") return name; // allow-list is gamertag-based
      if (!playerId) {
        throw new BadRequestException(
          `No XUID captured for ${name} yet — Bedrock operators need it (captured when they join).`,
        );
      }
      return playerId; // operators are XUID-based
    }
    // 7DTD serveradmin.xml entries are platform-prefixed ids.
    if (!playerId) {
      throw new BadRequestException(
        `No platform id captured for ${name} yet — it's captured when they're online.`,
      );
    }
    return playerId;
  }

  /** What the game's kick/ban commands take: ids where required, else the name. */
  private rconSubject(game: Game, name: string, playerId: string | null): string {
    if (game === Game.ASA || game === Game.ASE || game === Game.PALWORLD) {
      if (!playerId) {
        throw new BadRequestException(`No player id captured for ${name} yet — try while they're online.`);
      }
      return playerId;
    }
    return name; // Minecraft/Conan/7DTD take names
  }
}
