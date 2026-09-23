import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { EventType, Game, GAME_LABELS, ServerState } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsService } from "../events/events.service";
import { RconService } from "../rcon/rcon.service";
import { rconArg } from "../rcon/rcon-arg";
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

/** Parse a stored 24-slot histogram, tolerating legacy "[]" and bad JSON. */
export function parseHourCounts(json: string | null | undefined): number[] {
  try {
    const arr = JSON.parse(json || "[]") as number[];
    if (Array.isArray(arr) && arr.length === 24) return arr.map((n) => (Number.isFinite(n) ? n : 0));
  } catch {
    /* fall through to a fresh histogram */
  }
  return new Array<number>(24).fill(0);
}

export interface SeenPlayer {
  name: string;
  playerId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  online: boolean;
  /** Minutes of measured presence (0 on games without a live player list). */
  playtimeMinutes: number;
}

export interface PlayersView {
  players: SeenPlayer[];
  /** Actions this game supports (drives the UI's buttons). */
  supportedActions: PlayerAction[];
  /** The supported actions that go over the console, so need the server running. */
  liveActions: PlayerAction[];
  running: boolean;
  /** Whether this game records players at all. */
  tracked: boolean;
  /** How sightings are captured for this game (shown as a hint). */
  captureNote: string;
  /** Server-wide hour-of-day activity histogram (24 ints, UTC hours). */
  hourCounts: number[];
  /** Whether playtime is measured for this game (live player-list poll). */
  playtimeTracked: boolean;
}

/** Games whose player list is polled over RCON/telnet (needs the admin password). */
const RCON_POLL_GAMES = new Set<Game>([
  Game.ASA,
  Game.ASE,
  Game.CONAN,
  Game.PALWORLD,
  Game.PALWORLD_WINE,
  Game.MINECRAFT,
  Game.SEVEN_DAYS,
  Game.ZOMBOID,
  Game.FACTORIO,
  Game.RUST,
]);

const ACTIONS_BY_GAME: Record<Game, PlayerAction[]> = {
  [Game.ASA]: ["kick", "ban"],
  [Game.ASE]: ["kick", "ban"],
  [Game.CONAN]: ["kick", "ban"],
  [Game.PALWORLD]: ["kick", "ban"],
  [Game.PALWORLD_WINE]: ["kick", "ban"],
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
  [Game.ATS]: [], // no console; Convoy sessions have no server-side moderation
  [Game.ETS2]: [],
  [Game.CORE_KEEPER]: [], // no console; joins are gated by the secret Game ID
  [Game.TERRARIA]: [], // stdin console only; capture-only from join log lines
  [Game.FACTORIO]: ["kick", "ban", "whitelist", "admin"], // /kick /ban /whitelist add /promote
  [Game.RUST]: ["kick", "ban", "admin"], // kickid / banid / moderatorid (steamid-based)
  [Game.BEAMMP]: [], // stdin console only; joins visible in logs
  [Game.OPENTTD]: [], // no programmatic admin (in-game console only)
  [Game.CS2]: ["kick", "ban"], // Source RCON: kickid / banid
  [Game.DST]: [], // no RCON — admin via in-game console/listadminmoderation
  [Game.DRAGONWILDS]: [], // no console; the owner kicks/bans from the in-game Player List
};

const CAPTURE_NOTES: Partial<Record<Game, string>> = {
  [Game.ICARUS]: "Captured from join log lines (name only).",
  [Game.BEDROCK]: "Captured from join log lines (gamertag + XUID).",
  [Game.VALHEIM]: "Captured from join log lines (character name + SteamID64).",
  [Game.ENSHROUDED]: "Captured from the server's join and leave log lines.",
  [Game.TERRARIA]: "Captured from join log lines (character name).",
  [Game.DRAGONWILDS]: "Captured from join log lines (character name).",
  [Game.MINECRAFT]: "Captured from the live player list + join log lines.",
};

/** Whether an action edits the game's access-list files rather than going over RCON. */
function viaAccessList(game: Game, action: PlayerAction): boolean {
  return game === Game.VALHEIM || game === Game.BEDROCK || (game === Game.SEVEN_DAYS && action !== "kick");
}

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
  /** serverId → names seen in the last RCON poll, for leave detection. */
  private readonly lastPollNames = new Map<string, Set<string>>();
  /** serverId → names currently online per the join/leave log lines (Enshrouded). */
  private readonly logRoster = new Map<string, Set<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rcon: RconService,
    private readonly logCapture: LogCaptureService,
    private readonly accessLists: AccessListsService,
    private readonly events: EventsService,
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
      if (game === Game.ENSHROUDED) {
        // No player list to poll; the log-derived roster is the heartbeat instead.
        for (const name of this.logRoster.get(s.id) ?? []) await this.upsert(s.id, name, undefined, true);
        continue;
      }
      if (!RCON_POLL_GAMES.has(game) || !s.adminPasswordEnc) continue;
      try {
        const players = await this.listDetailed(s.id, game);
        // tick=true: each poll pass counts one minute of presence per player.
        for (const p of players) await this.upsert(s.id, p.name, p.playerId, true);
        // Leave detection: only the polled games have a reliable heartbeat, so a
        // name present last poll but not this one really did disconnect.
        const current = new Set(players.map((p) => p.name).filter(Boolean));
        const previous = this.lastPollNames.get(s.id);
        if (previous) {
          for (const name of previous) {
            if (!current.has(name)) await this.leave(s.id, name);
          }
        }
        this.lastPollNames.set(s.id, current);
      } catch {
        /* rcon down/booting — the next poll retries */
      }
    }
    // Forget poll state for servers that are no longer running (no "left" spam
    // when a server stops with players online).
    const runningIds = new Set(running.map((s) => s.id));
    for (const id of this.lastPollNames.keys()) {
      if (!runningIds.has(id)) this.lastPollNames.delete(id);
    }
    for (const id of this.logRoster.keys()) {
      if (!runningIds.has(id)) this.logRoster.delete(id);
    }
  }

  private async leave(serverId: string, name: string): Promise<void> {
    await this.events
      .emit({ type: EventType.PlayerLeave, message: `${name} left`, serverId, data: { name } })
      .catch(() => undefined);
  }

  /** Names + platform ids from the game's own player-list command. */
  private async listDetailed(serverId: string, game: Game): Promise<{ name: string; playerId?: string }[]> {
    if (game === Game.PALWORLD || game === Game.PALWORLD_WINE) {
      const out = await this.rcon.exec(serverId, "ShowPlayers");
      const players: { name: string; playerId?: string }[] = [];
      for (const l of out.split("\n").slice(1)) {
        const [name, , steamid] = l.split(",").map((x) => x?.trim());
        if (name) players.push({ name, playerId: steamid || undefined });
      }
      return players;
    }
    if (game === Game.MINECRAFT || game === Game.ZOMBOID || game === Game.FACTORIO) {
      // Zomboid's `players` / Factorio's `/players online` outputs are name-only.
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
    if (game === Game.RUST || game === Game.CS2) {
      // Source `status` → rows with a 17-digit steamid and a quoted name. CS2's
      // format differs slightly from Rust's but both match steamid+"name".
      const out = await this.rcon.exec(serverId, "status");
      return [...out.matchAll(/^\s*(\d{17})\s+"([^"]+)"/gm)].map((m) => ({
        name: m[2]!,
        playerId: m[1],
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
      // "Machine '1': Player '0(0)' logged in" precedes the real line; only the
      // real one carries the permissions suffix.
      const m = line.match(/Player '([^']+)' logged in with Permissions/i);
      if (m) {
        let roster = this.logRoster.get(serverId);
        if (!roster) this.logRoster.set(serverId, (roster = new Set()));
        roster.add(m[1]!);
        void this.upsert(serverId, m[1]!);
        return;
      }
      const left = line.match(/Remove Entity for Player '([^']+)'/i);
      if (left && this.logRoster.get(serverId)?.delete(left[1]!)) void this.leave(serverId, left[1]!);
      return;
    }
    if (game === Game.TERRARIA) {
      // "<CharName> has joined." (chat lines are "<name> text", so anchor on the
      // exact suffix; names are <= 20 chars).
      const m = line.match(/^(.{1,20}) has joined\.\s*$/);
      if (m) void this.upsert(serverId, m[1]!.trim());
    }
    if (game === Game.DRAGONWILDS) {
      // "LogNet: Join succeeded: <name>" — verified live; the earlier "Login request"
      // line carries the same name plus the base64 world password, so it is skipped.
      const m = line.match(/LogNet: Join succeeded: (\S+)/);
      if (m) void this.upsert(serverId, m[1]!);
    }
  }

  private async upsert(serverId: string, name: string, playerId?: string, tick = false): Promise<void> {
    if (!name) return;
    // A sighting after a stale (or absent) lastSeen means the player just came
    // online — both capture paths (RCON poll + join log lines) land here.
    const prev = await this.prisma.playerSighting
      .findUnique({
        where: { serverId_name: { serverId, name } },
        select: { lastSeenAt: true, hourCountsJson: true },
      })
      .catch(() => null);
    const wasOnline = prev !== null && Date.now() - prev.lastSeenAt.getTime() < ONLINE_WINDOW_MS;
    // tick = one measured minute of presence (poll path only): bump the total
    // and the UTC hour-of-day histogram that feeds the peak-hours heatmap.
    let counters = {};
    if (tick) {
      const hours = parseHourCounts(prev?.hourCountsJson);
      hours[new Date().getUTCHours()]!++;
      counters = { minutesPlayed: { increment: 1 }, hourCountsJson: JSON.stringify(hours) };
    }
    await this.prisma.playerSighting
      .upsert({
        where: { serverId_name: { serverId, name } },
        create: { serverId, name, playerId: playerId ?? null },
        // Never blank out a known platform id with a later id-less sighting.
        update: { lastSeenAt: new Date(), ...(playerId ? { playerId } : {}), ...counters },
      })
      .catch(() => undefined); // e.g. server deleted mid-flight
    if (!wasOnline) {
      await this.events
        .emit({ type: EventType.PlayerJoin, message: `${name} joined`, serverId, data: { name } })
        .catch(() => undefined);
    }
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
    // Server-wide peak-hours histogram = sum of every player's histogram.
    const hourCounts = new Array<number>(24).fill(0);
    for (const r of rows) {
      parseHourCounts(r.hourCountsJson).forEach((n, h) => (hourCounts[h]! += n));
    }
    const tracked = RCON_POLL_GAMES.has(game) || CAPTURE_NOTES[game] !== undefined;
    return {
      players: rows.map((r) => ({
        name: r.name,
        playerId: r.playerId,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        online: running && Date.now() - r.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
        playtimeMinutes: r.minutesPlayed,
      })),
      supportedActions: ACTIONS_BY_GAME[game],
      liveActions: ACTIONS_BY_GAME[game].filter((a) => !viaAccessList(game, a)),
      running,
      tracked,
      captureNote: !tracked
        ? `Player tracking isn't available for ${GAME_LABELS[game]}: Palisade can't read its player list.`
        : (CAPTURE_NOTES[game] ?? "Captured from the live player list every minute while the server runs."),
      hourCounts,
      playtimeTracked: RCON_POLL_GAMES.has(game) || game === Game.ENSHROUDED,
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
    if (viaAccessList(game, action)) {
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
    // Names come from live player lists — attacker-chosen. Sanitize whatever is
    // interpolated into a command (the sighting lookup above used the raw name).
    const safe = rconArg(name);
    if (game === Game.MINECRAFT && action === "whitelist") {
      await this.rcon.exec(serverId, `whitelist add ${safe}`);
      return { ok: true, detail: `${name} whitelisted` };
    }
    if (game === Game.MINECRAFT && action === "admin") {
      await this.rcon.exec(serverId, `op ${safe}`);
      return { ok: true, detail: `${name} opped` };
    }
    if (game === Game.ZOMBOID && action === "admin") {
      await this.rcon.exec(serverId, `setaccesslevel "${safe}" admin`);
      return { ok: true, detail: `${name} is now an admin` };
    }
    if (game === Game.FACTORIO && action === "whitelist") {
      await this.rcon.exec(serverId, `/whitelist add ${safe}`);
      return { ok: true, detail: `${name} whitelisted` };
    }
    if (game === Game.FACTORIO && action === "admin") {
      await this.rcon.exec(serverId, `/promote ${safe}`);
      return { ok: true, detail: `${name} promoted to admin` };
    }
    if (game === Game.RUST && action === "admin") {
      if (!playerId) throw new BadRequestException(`No SteamID captured for ${name} yet — try while they're online.`);
      await this.rcon.exec(serverId, `moderatorid ${rconArg(playerId)} "${safe}"`);
      await this.rcon.exec(serverId, "server.writecfg");
      return { ok: true, detail: `${name} is now a moderator` };
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
    if (game === Game.ASA || game === Game.ASE || game === Game.PALWORLD || game === Game.PALWORLD_WINE || game === Game.RUST) {
      if (!playerId) {
        throw new BadRequestException(`No player id captured for ${name} yet — try while they're online.`);
      }
      return playerId;
    }
    return name; // Minecraft/Conan/7DTD take names
  }
}
