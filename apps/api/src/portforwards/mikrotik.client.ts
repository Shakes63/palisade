import { request as httpsRequest } from "node:https";
import type { ForwardPort } from "../catalog/ports";
import { PROBE_PORT, PROBE_RULE_NAME, type RouterClient, type RouterRule } from "./router";

/** The slice of a RouterOS dstnat rule we read. Every value is a string — the
 *  REST API stringifies booleans and numbers alike. */
interface MikrotikNatRule {
  ".id": string;
  chain?: string;
  action?: string;
  protocol?: string;
  "dst-port"?: string;
  "to-addresses"?: string;
  "to-ports"?: string;
  "in-interface"?: string;
  comment?: string;
  disabled?: string;
}

interface MikrotikAddress {
  address?: string;
  interface?: string;
  dynamic?: string;
  invalid?: string;
  disabled?: string;
}

interface MikrotikError {
  error?: number;
  message?: string;
  detail?: string;
}

/** RouterOS's protocol matcher is single-valued, so a rule is tcp or udp; a
 *  "both" can only come from a hand-made rule that somehow can't happen, but
 *  normalising it the same way as the other clients keeps the service simple. */
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
 * WAN port-forwards via the RouterOS REST API (v7.1+). Forwards are dstnat rules
 * in /ip/firewall/nat; Palisade creates one per player-facing port. The REST API
 * uses HTTP Basic auth (a RouterOS user's name and password — there is no API
 * key), speaks JSON over https on 443, and applies each write immediately
 * (commit() is a no-op, like UniFi). A rule only needs a matching forward-chain
 * accept when the box's firewall is stricter than the stock config, which exempts
 * DSTNATed connections — that is left to the admin, see the settings help.
 *
 * RouterOS runs self-signed certs by default, so TLS verification is disabled.
 * Its `protocol` matcher is single-valued (no "tcp,udp" list); our forwards are
 * already one protocol each, so a forward is always exactly one NAT rule.
 *
 * A stock RouterOS with `www-ssl` enabled but no certificate assigned serves
 * anonymous Diffie-Hellman (ADH-*) only, which Node's OpenSSL disables at the
 * default security level — those ciphers have to be opted back in, or the TLS
 * handshake fails before any HTTP. Assigning a certificate to the service is the
 * better fix and is documented in the settings help.
 */
export class MikrotikClient implements RouterClient {
  readonly kind = "mikrotik" as const;
  /** Resolved once: the WAN value is an interface or an interface list. */
  private ingress: { prop: "in-interface" | "in-interface-list"; value: string } | null | undefined;

  constructor(
    readonly host: string,
    private readonly user: string,
    private readonly password: string,
    readonly targetIp: string,
    /** Ingress matcher for created rules — an interface or interface-list name.
     *  Blank omits it (matches any ingress). */
    private readonly wanInterface: string | null = null,
  ) {}

  private rest<T>(method: "GET" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const auth = Buffer.from(`${this.user}:${this.password}`).toString("base64");
      const req = httpsRequest(
        {
          host: this.host,
          path: `/rest${path}`,
          method,
          rejectUnauthorized: false, // RouterOS self-signed cert
          // Serves ADH-only when no cert is assigned; re-enable those at a lower
          // security level or the handshake fails with alert 40.
          ciphers: "ADH-AES256-SHA256:ADH-AES128-SHA256:ADH-AES256-SHA:ADH-AES128-SHA:@SECLEVEL=0",
          minVersion: "TLSv1.2",
          timeout: 15_000,
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
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
                return reject(new Error(`RouterOS ${status}: rejected — check the API user's name, password, and rights`));
              }
              return reject(new Error(`RouterOS ${status}: ${detail}`));
            }
            if (!data) return resolve(undefined as T);
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error("RouterOS returned a non-JSON response — is /rest enabled on the www-ssl service?"));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("RouterOS request timeout")));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** The single-object menus (cloud, resource) come back as either a bare object
   *  or a one-element array depending on version, so unwrap both. */
  private static unwrap<T>(res: T | T[] | undefined): T | undefined {
    if (res === undefined) return undefined;
    return Array.isArray(res) ? res[0] : res;
  }

  /** The ingress matcher for created rules. The configured value is either an
   *  interface (`ether1`) or an interface list (`WAN`, the stock default) — ask
   *  the router which it actually has, and send the matching property. Resolved
   *  once per client. A typo matches neither and is left as `in-interface`, so
   *  RouterOS rejects the write with a clear error instead of silently matching
   *  nothing. */
  private async ingressMatcher(): Promise<Record<string, string>> {
    if (!this.wanInterface) return {};
    if (this.ingress === undefined) {
      const lists = await this.rest<Array<{ name?: string }>>("GET", "/interface/list");
      const isList = (lists ?? []).some((l) => l.name === this.wanInterface);
      this.ingress = {
        prop: isList ? "in-interface-list" : "in-interface",
        value: this.wanInterface,
      };
    }
    return this.ingress ? { [this.ingress.prop]: this.ingress.value } : {};
  }

  async list(): Promise<RouterRule[]> {
    const rows = await this.rest<MikrotikNatRule[]>("GET", "/ip/firewall/nat");
    return (rows ?? [])
      .filter((r) => r.chain === "dstnat" && r.action === "dst-nat")
      .map(normalizeMikrotikNat);
  }

  async wanIp(): Promise<string | null> {
    if (this.wanInterface) {
      const addrs = await this.rest<MikrotikAddress[]>("GET", "/ip/address");
      const wan = (addrs ?? []).find(
        (a) => a.interface === this.wanInterface && a.disabled !== "true" && a.invalid !== "true",
      );
      if (wan?.address) return stripCidr(wan.address);
    }
    // A pppoe/dhcp WAN may have no /ip/address row; IP Cloud knows the actual
    // public address when it's enabled, and returns empty when it isn't.
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
      throw new Error(`RouterOS accepted the forward for ${f.port}/${f.proto} but returned no id — the user may lack write rights`);
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

  /** A disabled dstnat rule on the probe port, created then deleted. RouterOS
   *  reuses the port with no live traffic because the rule never fires. */
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
    if (!id) throw new Error("RouterOS accepted the test rule but returned no id — the user may lack write rights");
    try {
      await this.rest("DELETE", `/ip/firewall/nat/${id}`);
    } catch (e) {
      throw new Error(
        `RouterOS created the test rule but could not delete it: ${(e as Error).message}. Remove "${PROBE_RULE_NAME}" under IP → Firewall → NAT.`,
      );
    }
  }
}