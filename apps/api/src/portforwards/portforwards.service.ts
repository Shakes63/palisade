import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Game, DEFAULT_PORTS, GAME_LABELS } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { forwardSpec, type ForwardPort } from "../catalog/ports";
import {
  isPalisadeRule,
  portSpecCovers,
  protoCovers,
  ROUTER_LABELS,
  ruleName,
  type RouterClient,
  type RouterKind,
  type RouterRule,
} from "./router";
import { PfsenseClient } from "./pfsense.client";
import { UnifiClient } from "./unifi.client";

/** Per-forward state on the router:
 *  ok         — enabled WAN rule exists and points at the target
 *  disabled   — a matching rule exists but is disabled
 *  mismatched — an enabled rule exists for the port/proto but targets another host
 *  missing    — no rule at all */
export type ForwardState = "ok" | "disabled" | "mismatched" | "missing";

export interface ForwardStatus extends ForwardPort {
  state: ForwardState;
  /** The router's rule id when one exists (for enable/disable/delete). */
  ruleId: string | null;
  /** The host a mismatched rule currently points at. */
  actualTarget?: string | null;
}

/** Unsaved Settings-form values the Test button sends, so a router can be tried
 *  before Save. Anything omitted (or a blank API key) falls back to what's saved. */
export interface RouterDraft {
  router?: RouterKind;
  host?: string;
  apiKey?: string;
  site?: string;
  targetIp?: string;
}

/** The server columns port-forward logic needs; a deleted server is passed as
 *  a plain object because its row is already gone. */
export interface ForwardableServer {
  id: string;
  name: string;
  game: string;
  gamePort: number;
  rawSocketPort: number;
  queryPort: number;
  rconPort: number;
}

export interface PortForwardsView {
  /** Which router product Settings points at (pfSense unless switched). */
  router: RouterKind;
  /** Router host + API key + target IP are all configured. */
  configured: boolean;
  targetIp: string | null;
  /** The router's public (WAN) address — what friends connect to. */
  wanIp: string | null;
  forwards: ForwardStatus[];
}

/**
 * WAN port-forward management. The manager knows exactly which player-facing
 * ports each game needs (forwardSpec), so it can report each forward's state and
 * fix it: create missing rules, re-target mismatched ones, enable/disable, and
 * delete. The router-specific wire work lives in one RouterClient per product
 * (pfSense REST API, UniFi Network API); this service only reasons about rules.
 */
@Injectable()
export class PortForwardsService {
  private readonly logger = new Logger(PortForwardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ManagerSettingsService,
  ) {}

  /** The router product Settings selects. Unset means pfSense — the only option
   *  installs had before UniFi support, so their forwards keep working untouched. */
  async routerKind(): Promise<RouterKind> {
    const raw = await this.settings.get(SettingKeys.PortForwardRouter);
    return raw === "unifi" ? "unifi" : "pfsense";
  }

  /** A client for the selected router, or null while its settings are incomplete.
   *  A draft (the Test button's unsaved form) overrides saved values field by field. */
  private async client(draft: RouterDraft = {}): Promise<RouterClient | null> {
    const kind = draft.router ?? (await this.routerKind());
    const pick = async (key: string, override: string | undefined) =>
      override?.trim() || (await this.settings.get(key)) || null;
    if (kind === "unifi") {
      const [host, apiKey, site, targetIp] = await Promise.all([
        pick(SettingKeys.UnifiHost, draft.host),
        pick(SettingKeys.UnifiApiKey, draft.apiKey),
        pick(SettingKeys.UnifiSite, draft.site),
        pick(SettingKeys.UnifiTargetIp, draft.targetIp),
      ]);
      if (!host || !apiKey || !targetIp) return null;
      return new UnifiClient(host, apiKey, site?.trim() || "default", targetIp);
    }
    const [host, apiKey, targetIp] = await Promise.all([
      pick(SettingKeys.PfsenseHost, draft.host),
      pick(SettingKeys.PfsenseApiKey, draft.apiKey),
      pick(SettingKeys.PfsenseTargetIp, draft.targetIp),
    ]);
    if (!host || !apiKey || !targetIp) return null;
    return new PfsenseClient(host, apiKey, targetIp);
  }

  private async requireClient(): Promise<RouterClient> {
    const c = await this.client();
    if (!c) {
      const label = ROUTER_LABELS[await this.routerKind()];
      throw new BadRequestException(`Configure the ${label} host, API key, and target IP in Settings first.`);
    }
    return c;
  }

  private async server(id: string) {
    const s = await this.prisma.server.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("Server not found");
    return s;
  }

  private specFor(s: ForwardableServer) {
    return forwardSpec(s.game as Game, {
      game: s.gamePort,
      rawSocket: s.rawSocketPort,
      query: s.queryPort,
      rcon: s.rconPort,
    } as typeof DEFAULT_PORTS);
  }

  private wanIpCache: { key: string; ip: string | null; at: number } | null = null;

  /** The router's public address (cached 5 min per router; null on lookup failure). */
  private async wanIp(c: RouterClient): Promise<string | null> {
    const key = `${c.kind}:${c.host}`;
    if (this.wanIpCache?.key === key && Date.now() - this.wanIpCache.at < 300_000) return this.wanIpCache.ip;
    let ip: string | null = null;
    try {
      ip = await c.wanIp();
    } catch {
      /* status endpoint unavailable — just omit the WAN ip */
    }
    this.wanIpCache = { key, ip, at: Date.now() };
    return ip;
  }

  /** Validate router settings for the Settings page's Test button — the form's
   *  current values, falling back to what's saved — by reaching the API and
   *  reporting the WAN address and how many rules exist. */
  async testConnection(draft: RouterDraft = {}): Promise<{ ok: boolean; message: string }> {
    const kind = draft.router ?? (await this.routerKind());
    const label = ROUTER_LABELS[kind];
    const c = await this.client(draft);
    if (!c) return { ok: false, message: `Fill in the ${label} host, API key, and target IP first.` };
    try {
      const [detail, wanIp] = await Promise.all([c.describe(), this.wanIp(c)]);
      return {
        ok: true,
        message: `Connected to ${c.host} — WAN ${wanIp ?? "unknown"}, ${detail}. Forwards will target ${c.targetIp}.`,
      };
    } catch (e) {
      return { ok: false, message: `Could not reach the ${label} API: ${(e as Error).message}` };
    }
  }

  /** The WAN rule covering a forward's port/proto — target-matching rules first,
   *  then rules dedicated to exactly this port over shared lists/ranges. */
  private matchRule(rules: RouterRule[], f: ForwardPort, targetIp: string): RouterRule | undefined {
    const candidates = rules.filter((r) => protoCovers(r.proto, f.proto) && portSpecCovers(r.ports, f.port));
    return (
      candidates.find((r) => r.target === targetIp) ??
      candidates.find((r) => r.ports.trim() === String(f.port)) ??
      candidates[0]
    );
  }

  private classify(rule: RouterRule | undefined, targetIp: string): ForwardState {
    if (!rule) return "missing";
    if (!rule.enabled) return "disabled";
    return rule.target === targetIp ? "ok" : "mismatched";
  }

  /** Each of this server's player-facing forwards + its state on the router. */
  async status(id: string): Promise<PortForwardsView> {
    return this.viewFor(await this.server(id));
  }

  private async viewFor(s: ForwardableServer): Promise<PortForwardsView> {
    const spec = this.specFor(s);
    const c = await this.client();
    if (!c) {
      return {
        router: await this.routerKind(),
        configured: false,
        targetIp: null,
        wanIp: null,
        forwards: spec.map((f) => ({ ...f, state: "missing" as const, ruleId: null })),
      };
    }
    const [rules, wanIp] = await Promise.all([c.list(), this.wanIp(c)]);
    return {
      router: c.kind,
      configured: true,
      targetIp: c.targetIp,
      wanIp,
      forwards: spec.map((f) => {
        const rule = this.matchRule(rules, f, c.targetIp);
        const state = this.classify(rule, c.targetIp);
        return {
          ...f,
          state,
          ruleId: rule?.id ?? null,
          actualTarget: state === "mismatched" ? (rule?.target ?? null) : undefined,
        };
      }),
    };
  }

  /** The router's rule behind a forward-status row (re-listed so edits see fresh data). */
  private async ruleFor(c: RouterClient, f: ForwardStatus): Promise<RouterRule | undefined> {
    if (f.ruleId == null) return undefined;
    return (await c.list()).find((r) => r.id === f.ruleId);
  }

  /** Fix everything: create missing rules and re-target mismatched ones, then apply.
   *  Disabled rules are left alone (that's an explicit admin choice — use enable). */
  async apply(id: string): Promise<PortForwardsView> {
    const c = await this.requireClient();
    const s = await this.server(id);
    const before = await this.status(id);
    const label = ROUTER_LABELS[c.kind];
    let changed = 0;
    for (const f of before.forwards) {
      if (f.state === "missing") {
        await c.create(f, ruleName(GAME_LABELS[s.game as Game] ?? s.game, s.name, f.label));
        this.logger.log(`${label} forward created: ${f.port}/${f.proto} → ${c.targetIp} (${s.name})`);
        changed++;
      } else if (f.state === "mismatched") {
        const rule = await this.ruleFor(c, f);
        if (!rule) continue;
        await c.retarget(rule, f);
        this.logger.log(`${label} forward re-targeted: ${f.port}/${f.proto} → ${c.targetIp} (${s.name})`);
        changed++;
      }
    }
    if (changed > 0) await c.commit();
    return this.status(id);
  }

  /** Enable or disable one of this server's forwards on the router. */
  async setEnabled(id: string, port: number, proto: "udp" | "tcp", enabled: boolean): Promise<PortForwardsView> {
    const c = await this.requireClient();
    const view = await this.status(id);
    const f = view.forwards.find((x) => x.port === port && x.proto === proto);
    if (!f) throw new BadRequestException(`${port}/${proto} isn't one of this server's forwards`);
    const rule = await this.ruleFor(c, f);
    if (!rule) throw new NotFoundException("No rule exists for that port — create it first");
    await c.setEnabled(rule, enabled);
    await c.commit();
    this.logger.log(`${ROUTER_LABELS[c.kind]} forward ${enabled ? "enabled" : "disabled"}: ${port}/${proto}`);
    return this.status(id);
  }

  /** Delete one forward (port+proto), or ALL of this server's forwards when omitted. */
  async remove(id: string, port?: number, proto?: "udp" | "tcp"): Promise<PortForwardsView> {
    const c = await this.requireClient();
    const view = await this.status(id);
    const targets = view.forwards.filter(
      (f) => f.ruleId != null && (port === undefined || (f.port === port && f.proto === proto)),
    );
    if (port !== undefined && targets.length === 0) {
      throw new NotFoundException("No rule exists for that port");
    }
    const rules = await c.list();
    // One router rule can back several forwards (a tcp_udp or multi-port rule) — delete it once.
    const ids = new Set(targets.map((f) => f.ruleId));
    const doomed = rules.filter((r) => ids.has(r.id));
    await c.remove(doomed);
    for (const f of targets) this.logger.log(`${ROUTER_LABELS[c.kind]} forward deleted: ${f.port}/${f.proto}`);
    if (doomed.length > 0) await c.commit();
    return this.status(id);
  }

  /**
   * Server-deletion hook: drop the forwards Palisade made for a server that no
   * longer exists. Only rules we created (by name) that point at the configured
   * target go, and never one another server still needs — servers share a fixed
   * port block, so deleting one ARK server must not unplug the next. Best-effort:
   * a router problem is logged, never surfaced, because the server row is already
   * gone. Returns how many rules were removed.
   */
  async removeForServer(s: ForwardableServer): Promise<number> {
    let c: RouterClient | null;
    try {
      c = await this.client();
    } catch {
      return 0;
    }
    if (!c) return 0;
    try {
      const view = await this.viewFor(s);
      const rules = await c.list();
      const others = await this.prisma.server.findMany({ where: { id: { not: s.id } } });
      const stillNeeded = new Set(
        others.flatMap((o) => this.specFor(o as ForwardableServer).map((f) => `${f.port}/${f.proto}`)),
      );
      const doomed = new Map<string, RouterRule>();
      for (const f of view.forwards) {
        if (f.ruleId == null || stillNeeded.has(`${f.port}/${f.proto}`)) continue;
        const rule = rules.find((r) => r.id === f.ruleId);
        if (rule && rule.target === c.targetIp && isPalisadeRule(rule)) doomed.set(rule.id, rule);
      }
      if (doomed.size === 0) return 0;
      await c.remove([...doomed.values()]);
      await c.commit();
      for (const r of doomed.values()) {
        this.logger.log(`${ROUTER_LABELS[c.kind]} forward removed with server "${s.name}": ${r.ports}/${r.proto}`);
      }
      return doomed.size;
    } catch (e) {
      this.logger.warn(`Could not remove ${ROUTER_LABELS[c.kind]} forwards for "${s.name}": ${(e as Error).message}`);
      return 0;
    }
  }
}
