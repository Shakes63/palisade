import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Game, DEFAULT_PORTS } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { forwardSpec, type ForwardPort } from "../catalog/ports";
import { portSpecCovers, protoCovers, ROUTER_LABELS, type RouterClient, type RouterKind, type RouterRule } from "./router";
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

  /** A client for the selected router, or null while its settings are incomplete. */
  private async client(): Promise<RouterClient | null> {
    const kind = await this.routerKind();
    if (kind === "unifi") {
      const [host, apiKey, site, targetIp] = await Promise.all([
        this.settings.get(SettingKeys.UnifiHost),
        this.settings.get(SettingKeys.UnifiApiKey),
        this.settings.get(SettingKeys.UnifiSite),
        this.settings.get(SettingKeys.UnifiTargetIp),
      ]);
      if (!host || !apiKey || !targetIp) return null;
      return new UnifiClient(host, apiKey, site?.trim() || "default", targetIp);
    }
    const [host, apiKey, targetIp] = await Promise.all([
      this.settings.get(SettingKeys.PfsenseHost),
      this.settings.get(SettingKeys.PfsenseApiKey),
      this.settings.get(SettingKeys.PfsenseTargetIp),
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

  private specFor(s: { game: string; gamePort: number; rawSocketPort: number; queryPort: number; rconPort: number }) {
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

  /** Validate the configured router settings (for the Settings page's Test
   *  button): reaches the API, reports the WAN address and how many rules exist. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const kind = await this.routerKind();
    const label = ROUTER_LABELS[kind];
    const c = await this.client();
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
    const s = await this.server(id);
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
        await c.create(f, `ASM ${s.name} — ${f.label}`);
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
}
