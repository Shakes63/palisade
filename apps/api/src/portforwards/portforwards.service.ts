import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { request as httpsRequest } from "node:https";
import { Game, DEFAULT_PORTS } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { forwardSpec, type ForwardPort } from "../catalog/ports";

/** Per-forward state on the router:
 *  ok         — enabled WAN rule exists and points at the target
 *  disabled   — a matching rule exists but is disabled
 *  mismatched — an enabled rule exists for the port/proto but targets another host
 *  missing    — no rule at all */
export type ForwardState = "ok" | "disabled" | "mismatched" | "missing";

export interface ForwardStatus extends ForwardPort {
  state: ForwardState;
  /** pfSense rule id when one exists (for enable/disable/delete). */
  ruleId: number | null;
  /** The host a mismatched rule currently points at. */
  actualTarget?: string | null;
}

export interface PortForwardsView {
  /** pfSense host + API key + target IP are all configured. */
  configured: boolean;
  targetIp: string | null;
  /** The router's public (WAN) address — what friends connect to. */
  wanIp: string | null;
  forwards: ForwardStatus[];
}

/** The slice of a pfSense NAT rule we read. */
interface NatRule {
  id: number;
  interface?: string;
  protocol?: string;
  destination_port?: string;
  target?: string;
  disabled?: boolean;
}

/**
 * WAN port-forward management via the pfSense REST API (the jaredhendrickson13
 * package, /api/v2). The manager knows exactly which player-facing ports each game
 * needs (forwardSpec), so it can report each forward's state and fix it: create
 * missing rules, re-target mismatched ones, enable/disable, and delete. Rules are
 * created with associated_rule_id "pass" (auto firewall rule) and every change is
 * applied immediately. pfSense boxes run self-signed certs, so TLS verification is
 * disabled for this client. API quirk: single-object DELETE/PATCH want `id` in the
 * JSON body, not the query string.
 */
@Injectable()
export class PortForwardsService {
  private readonly logger = new Logger(PortForwardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ManagerSettingsService,
  ) {}

  private async config(): Promise<{ host: string; apiKey: string; targetIp: string } | null> {
    const [host, apiKey, targetIp] = await Promise.all([
      this.settings.get(SettingKeys.PfsenseHost),
      this.settings.get(SettingKeys.PfsenseApiKey),
      this.settings.get(SettingKeys.PfsenseTargetIp),
    ]);
    if (!host || !apiKey || !targetIp) return null;
    return { host, apiKey, targetIp };
  }

  private async requireConfig() {
    const cfg = await this.config();
    if (!cfg) {
      throw new BadRequestException("Configure the pfSense host, API key, and target IP in Settings first.");
    }
    return cfg;
  }

  /** Minimal JSON request against the pfSense REST API (self-signed cert tolerated). */
  private api<T>(
    cfg: { host: string; apiKey: string },
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpsRequest(
        {
          host: cfg.host,
          path: `/api/v2${path}`,
          method,
          rejectUnauthorized: false, // pfSense self-signed cert
          timeout: 15_000,
          headers: {
            "X-API-Key": cfg.apiKey,
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => {
            if ((res.statusCode ?? 500) >= 400) {
              return reject(new Error(`pfSense ${res.statusCode}: ${data.slice(0, 200)}`));
            }
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              resolve(undefined as T);
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("pfSense request timeout")));
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async applyChanges(cfg: { host: string; apiKey: string }): Promise<void> {
    // Apply twice — the reliable pattern against this API.
    await this.api(cfg, "POST", "/firewall/apply", {});
    await this.api(cfg, "POST", "/firewall/apply", {});
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

  private async rules(cfg: { host: string; apiKey: string }): Promise<NatRule[]> {
    const res = await this.api<{ data?: NatRule[] }>(cfg, "GET", "/firewall/nat/port_forwards?limit=0");
    return res.data ?? [];
  }

  private wanIpCache: { ip: string | null; at: number } | null = null;

  /** The WAN interface's public address (cached 5 min; null on lookup failure). */
  private async wanIp(cfg: { host: string; apiKey: string }): Promise<string | null> {
    if (this.wanIpCache && Date.now() - this.wanIpCache.at < 300_000) return this.wanIpCache.ip;
    let ip: string | null = null;
    try {
      const res = await this.api<{ data?: Array<{ name?: string; hwif?: string; ipaddr?: string }> }>(
        cfg,
        "GET",
        "/status/interfaces?limit=0",
      );
      const wan = (res.data ?? []).find((i) => (i.name ?? "").toLowerCase() === "wan") ?? res.data?.[0];
      ip = wan?.ipaddr ?? null;
    } catch {
      /* status endpoint unavailable — just omit the WAN ip */
    }
    this.wanIpCache = { ip, at: Date.now() };
    return ip;
  }

  /** The WAN rule matching a forward's port/proto — target-matching rules first. */
  private matchRule(rules: NatRule[], f: ForwardPort, targetIp: string): NatRule | undefined {
    const candidates = rules.filter(
      (r) =>
        (r.interface ?? "wan") === "wan" &&
        (r.protocol ?? "").toLowerCase() === f.proto &&
        String(r.destination_port ?? "") === String(f.port),
    );
    return candidates.find((r) => r.target === targetIp) ?? candidates[0];
  }

  private classify(rule: NatRule | undefined, targetIp: string): ForwardState {
    if (!rule) return "missing";
    if (rule.disabled) return "disabled";
    return rule.target === targetIp ? "ok" : "mismatched";
  }

  /** Each of this server's player-facing forwards + its state on the router. */
  async status(id: string): Promise<PortForwardsView> {
    const s = await this.server(id);
    const spec = this.specFor(s);
    const cfg = await this.config();
    if (!cfg) {
      return {
        configured: false,
        targetIp: null,
        wanIp: null,
        forwards: spec.map((f) => ({ ...f, state: "missing" as const, ruleId: null })),
      };
    }
    const [rules, wanIp] = await Promise.all([this.rules(cfg), this.wanIp(cfg)]);
    return {
      configured: true,
      targetIp: cfg.targetIp,
      wanIp,
      forwards: spec.map((f) => {
        const rule = this.matchRule(rules, f, cfg.targetIp);
        const state = this.classify(rule, cfg.targetIp);
        return {
          ...f,
          state,
          ruleId: rule?.id ?? null,
          actualTarget: state === "mismatched" ? (rule?.target ?? null) : undefined,
        };
      }),
    };
  }

  /** Fix everything: create missing rules and re-target mismatched ones, then apply.
   *  Disabled rules are left alone (that's an explicit admin choice — use enable). */
  async apply(id: string): Promise<PortForwardsView> {
    const cfg = await this.requireConfig();
    const s = await this.server(id);
    const before = await this.status(id);
    let changed = 0;
    for (const f of before.forwards) {
      if (f.state === "missing") {
        await this.api(cfg, "POST", "/firewall/nat/port_forward", {
          interface: "wan",
          ipprotocol: "inet",
          protocol: f.proto,
          source: "any",
          destination: "wan:ip",
          destination_port: String(f.port),
          target: cfg.targetIp,
          local_port: String(f.port),
          descr: `ASM ${s.name} — ${f.label}`,
          associated_rule_id: "pass",
          disabled: false,
        });
        this.logger.log(`pfSense forward created: ${f.port}/${f.proto} → ${cfg.targetIp} (${s.name})`);
        changed++;
      } else if (f.state === "mismatched" && f.ruleId != null) {
        await this.api(cfg, "PATCH", "/firewall/nat/port_forward", {
          id: f.ruleId,
          target: cfg.targetIp,
          local_port: String(f.port),
        });
        this.logger.log(`pfSense forward re-targeted: ${f.port}/${f.proto} → ${cfg.targetIp} (${s.name})`);
        changed++;
      }
    }
    if (changed > 0) await this.applyChanges(cfg);
    return this.status(id);
  }

  /** Enable or disable one of this server's forwards on the router. */
  async setEnabled(id: string, port: number, proto: "udp" | "tcp", enabled: boolean): Promise<PortForwardsView> {
    const cfg = await this.requireConfig();
    const view = await this.status(id);
    const f = view.forwards.find((x) => x.port === port && x.proto === proto);
    if (!f) throw new BadRequestException(`${port}/${proto} isn't one of this server's forwards`);
    if (f.ruleId == null) throw new NotFoundException("No rule exists for that port — create it first");
    await this.api(cfg, "PATCH", "/firewall/nat/port_forward", { id: f.ruleId, disabled: !enabled });
    await this.applyChanges(cfg);
    this.logger.log(`pfSense forward ${enabled ? "enabled" : "disabled"}: ${port}/${proto}`);
    return this.status(id);
  }

  /** Delete one forward (port+proto), or ALL of this server's forwards when omitted. */
  async remove(id: string, port?: number, proto?: "udp" | "tcp"): Promise<PortForwardsView> {
    const cfg = await this.requireConfig();
    const view = await this.status(id);
    const targets = view.forwards.filter(
      (f) => f.ruleId != null && (port === undefined || (f.port === port && f.proto === proto)),
    );
    if (port !== undefined && targets.length === 0) {
      throw new NotFoundException("No rule exists for that port");
    }
    // Delete highest id first so earlier deletions don't shift later ids.
    for (const f of [...targets].sort((a, b) => (b.ruleId ?? 0) - (a.ruleId ?? 0))) {
      await this.api(cfg, "DELETE", "/firewall/nat/port_forward", { id: f.ruleId });
      this.logger.log(`pfSense forward deleted: ${f.port}/${f.proto}`);
    }
    if (targets.length > 0) await this.applyChanges(cfg);
    return this.status(id);
  }
}
