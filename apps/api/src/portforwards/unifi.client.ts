import { request as httpsRequest } from "node:https";
import type { ForwardPort } from "../catalog/ports";
import { portSpecCovers, type RouterClient, type RouterRule } from "./router";

/** The slice of a UniFi port-forward object we read. */
interface UnifiForward {
  _id: string;
  name?: string;
  enabled?: boolean;
  /** "wan" | "wan2" | "all" — every value is a WAN-facing interface. */
  pfwd_interface?: string;
  proto?: string; // "tcp" | "udp" | "tcp_udp"
  dst_port?: string; // "7777" | "7777,7778" | "7777-7779"
  fwd?: string;
  fwd_port?: string;
}

interface LegacyResponse<T> {
  meta?: { rc?: string; msg?: string };
  data?: T[];
}

/** Host as typed in Settings → hostname + port. Accepts "192.168.1.1",
 *  "192.168.1.1:8443", "https://unifi.example.com" and trailing slashes. */
export function parseUnifiHost(input: string): { hostname: string; port: number } {
  const trimmed = input.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  return { hostname: url.hostname, port: url.port ? Number(url.port) : 443 };
}

/** UniFi's forward object → the router-neutral shape the service reasons about. */
export function normalizeUnifiRule(r: UnifiForward): RouterRule {
  const proto = (r.proto ?? "").toLowerCase();
  return {
    id: r._id,
    name: r.name ?? "",
    proto: proto === "tcp_udp" ? "both" : proto === "tcp" ? "tcp" : "udp",
    ports: String(r.dst_port ?? ""),
    target: r.fwd ?? "",
    enabled: r.enabled !== false,
  };
}

/**
 * WAN port-forwards via the UniFi Network application's classic REST API
 * (`/api/s/{site}/rest/portforward`), authenticated with an API key (Settings →
 * Control Plane → Integrations). Verified against a UniFi OS console on Network
 * 10.5: the key works on the classic endpoints, which the newer Integration API
 * (`/integration/v1`) has no port-forward equivalent for yet.
 *
 * UniFi OS consoles (UDM, UCG, Cloud Key) front the Network app at
 * `/proxy/network`; a self-hosted Network application serves the same API at the
 * root. The client tries the console prefix first and falls back on a 404, then
 * remembers which one answered. Consoles run self-signed certs, so TLS
 * verification is disabled. Changes provision immediately — there is no apply step.
 */
export class UnifiClient implements RouterClient {
  readonly kind = "unifi" as const;
  private readonly hostname: string;
  private readonly port: number;
  private prefix: string | null = null;

  constructor(
    readonly host: string,
    private readonly apiKey: string,
    readonly site: string,
    readonly targetIp: string,
  ) {
    const parsed = parseUnifiHost(host);
    this.hostname = parsed.hostname;
    this.port = parsed.port;
  }

  private raw(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpsRequest(
        {
          host: this.hostname,
          port: this.port,
          path,
          method,
          rejectUnauthorized: false, // UniFi self-signed cert
          timeout: 15_000,
          headers: {
            "X-API-KEY": this.apiKey,
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 500, text }));
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("UniFi request timeout")));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Request against the Network app, resolving the UniFi OS `/proxy/network`
   *  prefix on first use. `path` is relative to the Network app root. */
  private async api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T[]> {
    const candidates = this.prefix === null ? ["/proxy/network", ""] : [this.prefix];
    let last: { status: number; text: string } | null = null;
    for (const prefix of candidates) {
      const res = await this.raw(method, `${prefix}${path}`, body);
      last = res;
      if (res.status === 404 && this.prefix === null) continue;
      this.prefix = prefix;
      break;
    }
    const res = last!;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `UniFi ${res.status}: rejected — check the API key (it needs admin rights) and the site name "${this.site}"`,
      );
    }
    let parsed: LegacyResponse<T> | null = null;
    try {
      parsed = JSON.parse(res.text) as LegacyResponse<T>;
    } catch {
      /* non-JSON body */
    }
    if (res.status >= 400 || (parsed?.meta?.rc && parsed.meta.rc !== "ok")) {
      const detail = parsed?.meta?.msg ?? res.text.slice(0, 200);
      throw new Error(`UniFi ${res.status}: ${detail}`);
    }
    return parsed?.data ?? [];
  }

  private sitePath(rest: string): string {
    return `/api/s/${encodeURIComponent(this.site)}/${rest}`;
  }

  async list(): Promise<RouterRule[]> {
    const rows = await this.api<UnifiForward>("GET", this.sitePath("rest/portforward"));
    return rows.map(normalizeUnifiRule);
  }

  async wanIp(): Promise<string | null> {
    const rows = await this.api<{ subsystem?: string; wan_ip?: string }>("GET", this.sitePath("stat/health"));
    return rows.find((s) => s.subsystem === "wan")?.wan_ip ?? null;
  }

  async describe(): Promise<string> {
    const rules = await this.list();
    let version = "";
    try {
      const res = await this.raw("GET", `${this.prefix ?? "/proxy/network"}/integration/v1/info`);
      const info = JSON.parse(res.text) as { applicationVersion?: string };
      if (info.applicationVersion) version = ` (Network ${info.applicationVersion})`;
    } catch {
      /* the Integration API is optional here */
    }
    return `site "${this.site}"${version}, ${rules.length} port-forward rule${rules.length === 1 ? "" : "s"}`;
  }

  async create(f: ForwardPort, description: string): Promise<void> {
    await this.api("POST", this.sitePath("rest/portforward"), {
      name: description.slice(0, 128), // UniFi validates name against .{1,128}
      enabled: true,
      pfwd_interface: "wan",
      src: "any",
      dst_port: String(f.port),
      fwd: this.targetIp,
      fwd_port: String(f.port),
      proto: f.proto,
      log: false,
    });
  }

  async retarget(rule: RouterRule, f: ForwardPort): Promise<void> {
    // A single-port rule gets its LAN port realigned too (parity with pfSense);
    // a shared list/range rule keeps whatever port mapping it already has.
    const single = /^\d+$/.test(rule.ports.trim()) && portSpecCovers(rule.ports, f.port);
    await this.api("PUT", this.sitePath(`rest/portforward/${rule.id}`), {
      fwd: this.targetIp,
      ...(single ? { fwd_port: String(f.port) } : {}),
    });
  }

  async setEnabled(rule: RouterRule, enabled: boolean): Promise<void> {
    await this.api("PUT", this.sitePath(`rest/portforward/${rule.id}`), { enabled });
  }

  async remove(rules: RouterRule[]): Promise<void> {
    for (const r of rules) {
      await this.api("DELETE", this.sitePath(`rest/portforward/${r.id}`));
    }
  }

  async commit(): Promise<void> {
    /* UniFi provisions each write immediately */
  }
}
