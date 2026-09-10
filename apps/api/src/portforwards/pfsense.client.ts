import { request as httpsRequest } from "node:https";
import type { ForwardPort } from "../catalog/ports";
import type { RouterClient, RouterRule } from "./router";

/** The slice of a pfSense NAT rule we read. */
interface NatRule {
  id: number;
  interface?: string;
  protocol?: string;
  destination_port?: string;
  target?: string;
  disabled?: boolean;
  descr?: string;
}

/**
 * WAN port-forwards via the pfSense REST API (the jaredhendrickson13 package,
 * /api/v2). Rules are created with associated_rule_id "pass" (auto firewall rule)
 * and every change is applied by commit(). pfSense boxes run self-signed certs, so
 * TLS verification is disabled for this client. API quirk: single-object
 * DELETE/PATCH want `id` in the JSON body, not the query string.
 */
export class PfsenseClient implements RouterClient {
  readonly kind = "pfsense" as const;

  constructor(
    readonly host: string,
    private readonly apiKey: string,
    readonly targetIp: string,
  ) {}

  /** Minimal JSON request against the pfSense REST API (self-signed cert tolerated). */
  private api<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpsRequest(
        {
          host: this.host,
          path: `/api/v2${path}`,
          method,
          rejectUnauthorized: false, // pfSense self-signed cert
          timeout: 15_000,
          headers: {
            "X-API-Key": this.apiKey,
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

  async list(): Promise<RouterRule[]> {
    const res = await this.api<{ data?: NatRule[] }>("GET", "/firewall/nat/port_forwards?limit=0");
    return (res.data ?? [])
      .filter((r) => (r.interface ?? "wan") === "wan")
      .map((r) => {
        const proto = (r.protocol ?? "").toLowerCase();
        return {
          id: String(r.id),
          name: r.descr ?? "",
          proto: proto === "tcp/udp" ? "both" : proto === "tcp" ? "tcp" : "udp",
          ports: String(r.destination_port ?? ""),
          target: r.target ?? "",
          enabled: !r.disabled,
        };
      });
  }

  async wanIp(): Promise<string | null> {
    const res = await this.api<{ data?: Array<{ name?: string; ipaddr?: string }> }>(
      "GET",
      "/status/interfaces?limit=0",
    );
    const wan = (res.data ?? []).find((i) => (i.name ?? "").toLowerCase() === "wan") ?? res.data?.[0];
    return wan?.ipaddr ?? null;
  }

  async describe(): Promise<string> {
    const rules = await this.list();
    return `${rules.length} NAT rule${rules.length === 1 ? "" : "s"}`;
  }

  async create(f: ForwardPort, description: string): Promise<void> {
    await this.api("POST", "/firewall/nat/port_forward", {
      interface: "wan",
      ipprotocol: "inet",
      protocol: f.proto,
      source: "any",
      destination: "wan:ip",
      destination_port: String(f.port),
      target: this.targetIp,
      local_port: String(f.port),
      descr: description,
      associated_rule_id: "pass",
      disabled: false,
    });
  }

  async retarget(rule: RouterRule, f: ForwardPort): Promise<void> {
    await this.api("PATCH", "/firewall/nat/port_forward", {
      id: Number(rule.id),
      target: this.targetIp,
      local_port: String(f.port),
    });
  }

  async setEnabled(rule: RouterRule, enabled: boolean): Promise<void> {
    await this.api("PATCH", "/firewall/nat/port_forward", { id: Number(rule.id), disabled: !enabled });
  }

  async remove(rules: RouterRule[]): Promise<void> {
    // Delete highest id first so earlier deletions don't shift later ids.
    for (const r of [...rules].sort((a, b) => Number(b.id) - Number(a.id))) {
      await this.api("DELETE", "/firewall/nat/port_forward", { id: Number(r.id) });
    }
  }

  async commit(): Promise<void> {
    // Apply twice — the reliable pattern against this API.
    await this.api("POST", "/firewall/apply", {});
    await this.api("POST", "/firewall/apply", {});
  }
}
