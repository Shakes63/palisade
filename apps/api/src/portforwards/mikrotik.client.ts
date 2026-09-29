import { request as httpsRequest, type RequestOptions } from "node:https";
import { request as httpRequest } from "node:http";
import type { ForwardPort } from "../catalog/ports";
import { PROBE_PORT, PROBE_RULE_NAME, type RouterClient, type RouterRule } from "./router";

/** The slice of a RouterOS dstnat rule we read. Every value is a string. */
interface MikrotikNatRule {
  ".id": string;
  chain?: string;
  action?: string;
  protocol?: string;
  "dst-port"?: string;
  "to-addresses"?: string;
  "to-ports"?: string;
  dynamic?: string;
  comment?: string;
  disabled?: string;
}

interface MikrotikAddress {
  address?: string;
  interface?: string;
  invalid?: string;
  disabled?: string;
}

interface MikrotikError {
  error?: number;
  message?: string;
  detail?: string;
}

/** Host as typed in Settings: a bare host, host:port, or a URL. An explicit
 *  http:// scheme means the plain `www` service, at 80 by default. */
export function parseMikrotikHost(input: string): { hostname: string; port: number; secure: boolean } {
  const trimmed = input.trim();
  const explicit = /^[a-z]+:\/\//i.test(trimmed);
  const url = new URL(explicit ? trimmed : `https://${trimmed}`);
  const secure = explicit ? url.protocol === "https:" : true;
  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    secure,
  };
}

/** RouterOS's protocol matcher is single-valued, so a rule is tcp or udp. */
export function normalizeMikrotikNat(r: MikrotikNatRule): RouterRule {
  const protocol = (r.protocol ?? "").toLowerCase();
  const proto = protocol.includes("tcp") && protocol.includes("udp") ? "both" : protocol === "tcp" ? "tcp" : "udp";
  return {
    id: r[".id"],
    name: r.comment ?? "",
    proto,
    ports: String(r["dst-port"] ?? ""),
    target: r["to-addresses"] ?? "",
    enabled: r.disabled !== "true",
  };
}

/** The address part of RouterOS's "192.168.1.50/24" form. */
export function stripCidr(address: string): string {
  return address.split("/")[0] ?? address;
}

/**
 * WAN port-forwards via the RouterOS REST API (v7.1+): dstnat rules in
 * /ip/firewall/nat, HTTP Basic auth, and each write applied immediately. See the
 * settings help for the policies the API user needs.
 */
export class MikrotikClient implements RouterClient {
  readonly kind = "mikrotik" as const;
  private readonly hostname: string;
  private readonly port: number;
  private readonly secure: boolean;
  /** Resolved once: whether the WAN value is an interface or a list. */
  private ingress: { prop: "in-interface" | "in-interface-list"; value: string } | null = null;
  /** Which TLS ciphers the box accepted, so the fallback is tried only once. */
  private tls: "default" | "adh" | null = null;

  /** A RouterOS with www-ssl but no certificate serves anonymous DH only, which
   *  Node rejects by default. */
  private static readonly ADH_CIPHERS =
    "ADH-AES256-SHA256:ADH-AES128-SHA256:ADH-AES256-SHA:ADH-AES128-SHA:@SECLEVEL=0";

  constructor(
    readonly host: string,
    private readonly user: string,
    private readonly password: string,
    readonly targetIp: string,
    /** An interface or interface-list name. Blank matches any ingress. */
    private readonly wanInterface: string | null = null,
  ) {
    const parsed = parseMikrotikHost(host);
    this.hostname = parsed.hostname;
    this.port = parsed.port;
    this.secure = parsed.secure;
  }

  /** A unique key for the service's WAN-IP cache; host alone misses a changed WAN. */
  get cacheKey(): string {
    return `${this.kind}:${this.hostname}:${this.port}:${this.secure ? "s" : ""}:${this.wanInterface ?? ""}`;
  }

  private static isHandshakeError(e: unknown): boolean {
    const err = e as { code?: string; message?: string };
    return err?.code === "EPROTO" || /handshake failure|alert number 40|sslv3 alert/i.test(err?.message ?? "");
  }

  private send<T>(method: string, path: string, body: unknown, adh: boolean): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const auth = Buffer.from(`${this.user}:${this.password}`).toString("base64");
      const options: RequestOptions = {
        host: this.hostname,
        port: this.port,
        path: `/rest${path}`,
        method,
        // RouterOS runs a self-signed cert
        ...(this.secure ? { rejectUnauthorized: false, minVersion: "TLSv1.2" } : {}),
        timeout: 15_000,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      };
      if (adh) options.ciphers = MikrotikClient.ADH_CIPHERS;
      const req = (this.secure ? httpsRequest : httpRequest)(options, (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          const status = res.statusCode ?? 500;
          if (status >= 400) {
            let detail = data.slice(0, 200);
            try {
              const e = JSON.parse(data) as MikrotikError;
              detail = e.detail ?? e.message ?? detail;
            } catch {
              /* non-JSON error body */
            }
            if (status === 401 || status === 403) {
              return reject(new Error(`RouterOS ${status}: rejected, check the API user's name, password, and rights`));
            }
            return reject(new Error(`RouterOS ${status}: ${detail}`));
          }
          if (!data) return resolve(undefined as T);
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error("RouterOS returned a non-JSON response, is /rest enabled on the www-ssl service?"));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("RouterOS request timeout")));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Normal TLS first; a certificate-less www-ssl only accepts the ADH suites, so
   *  retry with those on a handshake failure and remember the choice. */
  private async rest<T>(method: "GET" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (this.tls === "adh") return this.send<T>(method, path, body, true);
    if (this.tls === "default") return this.send<T>(method, path, body, false);
    try {
      const result = await this.send<T>(method, path, body, false);
      this.tls = "default";
      return result;
    } catch (e) {
      if (!MikrotikClient.isHandshakeError(e)) throw e;
      const result = await this.send<T>(method, path, body, true);
      this.tls = "adh";
      return result;
    }
  }

  /** The single-object menus come back as an object or a one-element array. */
  private static unwrap<T>(res: T | T[] | undefined): T | undefined {
    if (res === undefined) return undefined;
    return Array.isArray(res) ? res[0] : res;
  }

  /** Resolve once whether the configured WAN value is an interface or a list. */
  private async resolveIngress(): Promise<void> {
    if (this.ingress !== null || !this.wanInterface) return;
    const lists = await this.rest<Array<{ name?: string }>>("GET", "/interface/list");
    const isList = (lists ?? []).some((l) => l.name === this.wanInterface);
    this.ingress = { prop: isList ? "in-interface-list" : "in-interface", value: this.wanInterface };
  }

  private async ingressMatcher(): Promise<Record<string, string>> {
    await this.resolveIngress();
    return this.ingress ? { [this.ingress.prop]: this.ingress.value } : {};
  }

  async list(): Promise<RouterRule[]> {
    const rows = await this.rest<MikrotikNatRule[]>("GET", "/ip/firewall/nat");
    return (rows ?? [])
      // Dynamic rules (UPnP) can't be edited or deleted, and only tcp/udp map onto
      // the router-neutral shape.
      .filter((r) => r.chain === "dstnat" && r.action === "dst-nat" && r.dynamic !== "true")
      .filter((r) => /tcp|udp/.test(r.protocol ?? ""))
      .map(normalizeMikrotikNat);
  }

  async wanIp(): Promise<string | null> {
    await this.resolveIngress();
    if (this.ingress) {
      const addrs = await this.rest<MikrotikAddress[]>("GET", "/ip/address");
      let ifaces: string[];
      if (this.ingress.prop === "in-interface-list") {
        const members = await this.rest<Array<{ list?: string; interface?: string }>>("GET", "/interface/list/member");
        ifaces = (members ?? [])
          .filter((m) => m.list === this.ingress!.value)
          .map((m) => m.interface)
          .filter((x): x is string => !!x);
      } else {
        ifaces = [this.ingress.value];
      }
      const wan = (addrs ?? []).find(
        (a) => a.interface !== undefined && ifaces.includes(a.interface) && a.disabled !== "true" && a.invalid !== "true",
      );
      if (wan?.address) return stripCidr(wan.address);
    }
    // IP Cloud knows the public address when the WAN has no /ip/address row.
    const cloud = MikrotikClient.unwrap(
      await this.rest<{ "public-address"?: string } | Array<{ "public-address"?: string }>>("GET", "/ip/cloud"),
    );
    return cloud?.["public-address"] || null;
  }

  async describe(): Promise<string> {
    const resource = MikrotikClient.unwrap(
      await this.rest<{ version?: string } | Array<{ version?: string }>>("GET", "/system/resource"),
    );
    const rules = await this.list();
    const version = resource?.version ? ` (RouterOS ${resource.version})` : "";
    return `${rules.length} dstnat rule${rules.length === 1 ? "" : "s"}${version}`;
  }

  async create(f: ForwardPort, description: string): Promise<void> {
    const created = await this.rest<MikrotikNatRule>("PUT", "/ip/firewall/nat", {
      chain: "dstnat",
      action: "dst-nat",
      protocol: f.proto,
      "dst-port": String(f.port),
      "to-addresses": this.targetIp,
      "to-ports": String(f.port),
      comment: description,
      disabled: "false",
      ...(await this.ingressMatcher()),
    });
    if (!created?.[".id"]) {
      throw new Error(`RouterOS accepted the forward for ${f.port}/${f.proto} but returned no id, the user may lack write rights`);
    }
  }

  async retarget(rule: RouterRule, f: ForwardPort): Promise<void> {
    await this.rest("PATCH", `/ip/firewall/nat/${rule.id}`, {
      "to-addresses": this.targetIp,
      "to-ports": String(f.port),
    });
  }

  async setEnabled(rule: RouterRule, enabled: boolean): Promise<void> {
    await this.rest("PATCH", `/ip/firewall/nat/${rule.id}`, { disabled: enabled ? "false" : "true" });
  }

  async remove(rules: RouterRule[]): Promise<void> {
    for (const r of rules) {
      await this.rest("DELETE", `/ip/firewall/nat/${r.id}`);
    }
  }

  async commit(): Promise<void> {
    /* RouterOS applies each write immediately */
  }

  async probeWrite(): Promise<void> {
    const created = await this.rest<MikrotikNatRule>("PUT", "/ip/firewall/nat", {
      chain: "dstnat",
      action: "dst-nat",
      protocol: "tcp",
      "dst-port": String(PROBE_PORT),
      "to-addresses": this.targetIp,
      "to-ports": String(PROBE_PORT),
      comment: PROBE_RULE_NAME,
      disabled: "true",
      ...(await this.ingressMatcher()),
    });
    const id = created?.[".id"];
    if (!id) throw new Error("RouterOS accepted the test rule but returned no id, the user may lack write rights");
    try {
      await this.rest("DELETE", `/ip/firewall/nat/${id}`);
    } catch (e) {
      throw new Error(
        `RouterOS created the test rule but could not delete it: ${(e as Error).message}. Remove "${PROBE_RULE_NAME}" under IP, Firewall, NAT.`,
      );
    }
  }
}
