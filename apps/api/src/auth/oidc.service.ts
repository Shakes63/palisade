import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, createPublicKey, randomBytes, type JsonWebKey } from "node:crypto";
import * as jwt from "jsonwebtoken";
import type { Role } from "@ark/shared";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { loadEnv } from "../config/env";
import { AuthService } from "./auth.service";

const FLOW_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 60_000;
const ID_TOKEN_ALGS: jwt.Algorithm[] = [
  "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "HS256", "HS384", "HS512",
];

interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  groups: Record<Role, string | null>;
  groupsClaim: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

interface Flow {
  verifier: string;
  nonce: string;
  /** Set when a signed-in user is linking their SSO identity rather than signing in. */
  linkUserId?: string;
  expires: number;
}

const base64url = (b: Buffer) => b.toString("base64url");
const trimSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * The group names in `claim`: an exact claim name first (Auth0's are URLs, dots and all), then a
 * dotted path (Keycloak's `realm_access.roles`). Objects count by key, as Zitadel keys roles by name.
 */
export function readGroups(claims: Record<string, unknown>, claim: string): string[] {
  let value: unknown = claims;
  for (const key of claim in claims ? [claim] : claim.split(".")) {
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }
  if (typeof value === "string") value = [value];
  else if (value && typeof value === "object" && !Array.isArray(value)) value = Object.keys(value);
  return Array.isArray(value) ? value.filter((g): g is string => typeof g === "string") : [];
}

/** The highest role whose configured group the user is in. */
export function roleForGroups(groups: string[], mapping: Record<Role, string | null>): Role | null {
  const member = new Set(groups);
  return (["admin", "operator", "viewer"] as const).find((r) => mapping[r] && member.has(mapping[r])) ?? null;
}

/**
 * Sign-in through an OpenID Connect provider (Authentik, Keycloak, Authelia, …) with the
 * authorization code flow and PKCE. The browser is sent to the provider and back to
 * /api/auth/oidc/callback, which hands the web UI a one-time ticket for a Palisade token.
 */
@Injectable()
export class OidcService {
  private readonly flows = new Map<string, Flow>();
  private readonly tickets = new Map<string, { token: string; expires: number }>();

  constructor(
    private readonly settings: ManagerSettingsService,
    private readonly auth: AuthService,
  ) {}

  async enabled(): Promise<boolean> {
    return (await this.config()) !== null;
  }

  /** How the login page offers SSO. Both switches are moot while SSO is not configured. */
  async loginOptions(): Promise<{ sso: boolean; ssoOnly: boolean; ssoAutoRedirect: boolean }> {
    const sso = await this.enabled();
    const on = async (key: string) => sso && (await this.settings.get(key)) === "true";
    return {
      sso,
      ssoOnly: await on(SettingKeys.OidcHidePassword),
      ssoAutoRedirect: await on(SettingKeys.OidcAutoRedirect),
    };
  }

  /** What to register at the provider as the redirect URI. */
  async redirectUri(): Promise<string> {
    const base = (await this.settings.getPublicBaseUrl()) ?? loadEnv().PUBLIC_BASE_URL;
    return `${trimSlash(base)}/api/auth/oidc/callback`;
  }

  /**
   * Start a flow: the provider URL to send the browser to, and the state to pin in a cookie.
   * `origin` is where the browser has Palisade open; the cookie only returns to that host.
   */
  async begin(linkUserId?: string, origin?: string): Promise<{ url: string; state: string }> {
    const cfg = await this.requireConfig();
    const redirectUri = await this.redirectUri();
    const openedAt = URL.canParse(origin ?? "") ? new URL(origin!) : null;
    if (openedAt && openedAt.hostname !== new URL(redirectUri).hostname) {
      throw new BadRequestException(
        `You opened Palisade at ${openedAt.origin}, but SSO returns to ${new URL(redirectUri).origin}. Open ` +
          "Palisade at that address, or set the public base URL under Settings → General to the one you use.",
      );
    }
    const discovery = await this.discover(cfg.issuer);
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));
    this.prune();
    this.flows.set(state, { verifier, nonce, linkUserId, expires: Date.now() + FLOW_TTL_MS });

    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), state };
  }

  isLinkFlow(state: string): boolean {
    return this.flows.get(state)?.linkUserId !== undefined;
  }

  /**
   * Finish a flow from the provider's redirect. `cookieState` must match `state`, which
   * ties the callback to the browser that started it (login CSRF). The provider's error is
   * only passed on after that check, so a crafted link cannot put words on the login page.
   */
  async complete(
    state: string | undefined,
    cookieState: string | undefined,
    code: string | undefined,
    providerError?: string,
  ): Promise<{ ticket: string } | { linked: true }> {
    const flow = state ? this.flows.get(state) : undefined;
    if (state) this.flows.delete(state);
    if (!flow || flow.expires < Date.now() || cookieState !== state) {
      throw new UnauthorizedException(
        "Sign-in expired, or was started in another browser or at another address; try again",
      );
    }
    if (providerError || !code) throw new UnauthorizedException(providerError || "The provider sent no code");
    const cfg = await this.requireConfig();
    const discovery = await this.discover(cfg.issuer);
    const idToken = await this.exchangeCode(cfg, discovery, code, flow.verifier);
    const claims = await this.verifyIdToken(cfg, discovery, idToken);
    if (claims.nonce !== flow.nonce) throw new UnauthorizedException("ID token nonce mismatch");
    if (typeof claims.sub !== "string" || !claims.sub) throw new UnauthorizedException("ID token has no subject");

    const managesRoles = Object.values(cfg.groups).some(Boolean);
    const role = managesRoles ? roleForGroups(readGroups(claims, cfg.groupsClaim), cfg.groups) : null;
    if (managesRoles && !role) {
      if (!flow.linkUserId) await this.auth.oidcRevoke(claims.sub);
      throw new ForbiddenException("Your SSO account is not in any group that grants access to Palisade");
    }
    if (flow.linkUserId) {
      await this.auth.linkOidc(flow.linkUserId, claims.sub, role);
      return { linked: true };
    }
    const username = [claims.preferred_username, claims.email, claims.sub].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    )!;
    const { token } = await this.auth.oidcSignIn(claims.sub, username.trim(), role);
    const ticket = base64url(randomBytes(32));
    this.tickets.set(ticket, { token, expires: Date.now() + TICKET_TTL_MS });
    return { ticket };
  }

  /** Trade a one-time ticket from the callback for the Palisade token. */
  redeem(ticket: string): { token: string } {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.expires < Date.now()) throw new UnauthorizedException("Sign-in expired; try again");
    return { token: entry.token };
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.flows) if (v.expires < now) this.flows.delete(k);
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
  }

  private async config(): Promise<OidcConfig | null> {
    const get = async (key: string) => (await this.settings.get(key))?.trim() || null;
    const issuer = await get(SettingKeys.OidcIssuer);
    const clientId = await get(SettingKeys.OidcClientId);
    if (!issuer || !clientId) return null;
    return {
      issuer,
      clientId,
      clientSecret: await get(SettingKeys.OidcClientSecret),
      groups: {
        admin: await get(SettingKeys.OidcAdminGroup),
        operator: await get(SettingKeys.OidcOperatorGroup),
        viewer: await get(SettingKeys.OidcViewerGroup),
      },
      groupsClaim: (await get(SettingKeys.OidcGroupsClaim)) ?? "groups",
    };
  }

  private async requireConfig(): Promise<OidcConfig> {
    const cfg = await this.config();
    if (!cfg) throw new ForbiddenException("Single sign-on is not configured");
    return cfg;
  }

  private async discover(issuer: string): Promise<Discovery> {
    const doc = await fetchJson<Discovery>(`${trimSlash(issuer)}/.well-known/openid-configuration`);
    if (trimSlash(doc.issuer ?? "") !== trimSlash(issuer)) {
      throw new UnauthorizedException(`Provider reports issuer "${doc.issuer}", expected "${issuer}"`);
    }
    return doc;
  }

  private async exchangeCode(cfg: OidcConfig, d: Discovery, code: string, verifier: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: await this.redirectUri(),
      code_verifier: verifier,
      client_id: cfg.clientId,
    });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (cfg.clientSecret) {
      const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
      if (!methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
        body.set("client_secret", cfg.clientSecret);
      } else {
        const creds = `${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`;
        headers.Authorization = `Basic ${Buffer.from(creds).toString("base64")}`;
      }
    }
    const res = await fetchJson<{ id_token?: string }>(d.token_endpoint, { method: "POST", headers, body });
    if (!res.id_token) throw new UnauthorizedException("Provider returned no ID token");
    return res.id_token;
  }

  private async verifyIdToken(cfg: OidcConfig, d: Discovery, idToken: string): Promise<jwt.JwtPayload> {
    const header = jwt.decode(idToken, { complete: true })?.header;
    const alg = header?.alg as jwt.Algorithm | undefined;
    if (!alg || !ID_TOKEN_ALGS.includes(alg)) throw new UnauthorizedException(`Unsupported ID token algorithm ${alg}`);

    let key: jwt.Secret | ReturnType<typeof createPublicKey>;
    if (alg.startsWith("HS")) {
      // Providers sign with the client secret when no signing key is set (Authentik's default).
      if (!cfg.clientSecret) throw new UnauthorizedException("ID token is signed with a client secret, but none is set");
      key = cfg.clientSecret;
    } else {
      const { keys = [] } = await fetchJson<{ keys?: (JsonWebKey & { kid?: string })[] }>(d.jwks_uri);
      const jwk = header?.kid ? keys.find((k) => k.kid === header.kid) : keys.length === 1 ? keys[0] : undefined;
      if (!jwk) throw new UnauthorizedException("No provider signing key matches the ID token");
      key = createPublicKey({ key: jwk, format: "jwk" });
    }
    try {
      return jwt.verify(idToken, key, { algorithms: [alg], issuer: d.issuer, audience: cfg.clientId }) as jwt.JwtPayload;
    } catch (e) {
      throw new UnauthorizedException(`Invalid ID token: ${(e as Error).message}`);
    }
  }
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new UnauthorizedException(`Could not reach the SSO provider at ${new URL(url).origin}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    const detail = err.error_description ?? err.error ?? `HTTP ${res.status}`;
    throw new UnauthorizedException(`SSO provider rejected ${new URL(url).pathname}: ${detail}`);
  }
  return (await res.json()) as T;
}
