import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import * as jwt from "jsonwebtoken";
import { OidcService, readGroups, roleForGroups } from "./oidc.service";
import { SettingKeys } from "../manager-settings/manager-settings.service";

const ISSUER = "https://auth.example.com/application/o/palisade/";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const ID = { issuer: ISSUER, subject: "abc" };

function makeService(settings: Record<string, string> = {}, publicBaseUrl = "http://panel.lan:3000/") {
  const values: Record<string, string> = {
    [SettingKeys.OidcIssuer]: ISSUER,
    [SettingKeys.OidcClientId]: "palisade",
    [SettingKeys.OidcClientSecret]: "s3cret",
    ...settings,
  };
  const auth = {
    oidcSignIn: vi.fn(async () => ({ token: "palisade-token" })),
    linkOidc: vi.fn(async () => undefined),
    oidcRevoke: vi.fn(async () => undefined),
  };
  const svc = new OidcService(
    { get: async (k: string) => values[k] ?? null, getPublicBaseUrl: async () => publicBaseUrl } as never,
    auth as never,
  );
  return { svc, auth };
}

/** A provider whose token endpoint answers with whatever `idToken(nonce)` signs. */
function stubProvider(idToken: (nonce: string) => string) {
  let nonce = "";
  const tokenRequests: RequestInit[] = [];
  const fetched: string[] = [];
  const jwks = { kid: "k1" };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    fetched.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: "https://auth.example.com/application/o/authorize/",
        token_endpoint: "https://auth.example.com/application/o/token/",
        jwks_uri: "https://auth.example.com/application/o/palisade/jwks/",
      });
    }
    if (url.endsWith("/jwks/")) return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: jwks.kid }] });
    if (url.endsWith("/token/")) {
      tokenRequests.push(init);
      return json({ id_token: idToken(nonce) });
    }
    return new Response("{}", { status: 404 });
  });
  return {
    tokenRequests,
    fetched,
    jwks,
    /** Start a flow and remember the nonce the provider would echo back. */
    async begin(svc: OidcService, linkUserId?: string) {
      const flow = await svc.begin(linkUserId, "http://panel.lan:3000");
      nonce = new URL(flow.url).searchParams.get("nonce")!;
      return flow;
    },
  };
}

const rs256 = (claims: object, opts: jwt.SignOptions = {}) =>
  jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: "k1", issuer: ISSUER, audience: "palisade", expiresIn: 60, ...opts });

describe("OidcService", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("is off until an issuer and client id are set", async () => {
    expect((await makeService().svc.loginOptions()).sso).toBe(true);
    expect((await makeService({ [SettingKeys.OidcIssuer]: "" }).svc.loginOptions()).sso).toBe(false);
  });

  it("only hides the password form or auto-redirects while SSO is configured", async () => {
    const switches = { [SettingKeys.OidcHidePassword]: "true", [SettingKeys.OidcAutoRedirect]: "true" };
    expect(await makeService(switches).svc.loginOptions()).toEqual({ sso: true, ssoOnly: true, ssoAutoRedirect: true });
    expect(await makeService({ ...switches, [SettingKeys.OidcClientId]: "" }).svc.loginOptions()).toEqual({
      sso: false,
      ssoOnly: false,
      ssoAutoRedirect: false,
    });
  });

  it("sends the browser to the provider with PKCE and the redirect URI", async () => {
    const { svc } = makeService();
    const idp = stubProvider(() => "");
    const { url, state } = await idp.begin(svc);
    const q = new URL(url).searchParams;
    expect(q.get("redirect_uri")).toBe("http://panel.lan:3000/api/auth/oidc/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toBe(state);
    expect(q.get("scope")).toContain("openid");
  });

  it("refuses to start from an address the flow cookie would not come back to", async () => {
    const { svc } = makeService();
    stubProvider(() => "");
    await expect(svc.begin(undefined, "http://192.168.1.10:3000")).rejects.toThrow(
      /opened Palisade at http:\/\/192\.168\.1\.10:3000, but SSO returns to http:\/\/panel\.lan:3000/,
    );
    // Cookies ignore the port, so another port on the same host is fine.
    await expect(svc.begin(undefined, "http://panel.lan:8080")).resolves.toBeDefined();
    // A secure cookie set for https never comes back to a page opened over http.
    const secure = makeService({}, "https://panel.lan/").svc;
    await expect(secure.begin(undefined, "http://panel.lan")).rejects.toThrow(/opened Palisade at http:\/\/panel\.lan,/);
    await expect(secure.begin(undefined, "https://panel.lan")).resolves.toBeDefined();
  });

  it("only passes the provider's error on for the browser that started the flow", async () => {
    const { svc } = makeService();
    const idp = stubProvider(() => "");
    let { state } = await idp.begin(svc);
    await expect(svc.complete(state, undefined, undefined, "Sign in at evil.example")).rejects.toThrow(/another browser/);
    await expect(svc.complete(undefined, undefined, undefined, "Sign in at evil.example")).rejects.toThrow(/another browser/);
    ({ state } = await idp.begin(svc));
    await expect(svc.complete(state, state, undefined, "access_denied")).rejects.toThrow("access_denied");
  });

  it("signs in a verified identity and trades the ticket for a token exactly once", async () => {
    const { svc, auth } = makeService();
    const idp = stubProvider((nonce) => rs256({ sub: "abc", preferred_username: "magnus", nonce }));
    const { state } = await idp.begin(svc);
    const result = await svc.complete(state, state, "the-code");
    expect(auth.oidcSignIn).toHaveBeenCalledWith(ID, "magnus", null, false);
    expect(new Headers(idp.tokenRequests[0]!.headers).get("authorization")).toMatch(/^Basic /);
    const ticket = (result as { ticket: string }).ticket;
    expect(svc.redeem(ticket)).toEqual({ token: "palisade-token" });
    expect(() => svc.redeem(ticket)).toThrow();
  });

  it("accepts ID tokens signed with the client secret", async () => {
    const { svc, auth } = makeService();
    const idp = stubProvider((nonce) =>
      jwt.sign({ sub: "abc", nonce }, "s3cret", { algorithm: "HS256", issuer: ISSUER, audience: "palisade" }),
    );
    const { state } = await idp.begin(svc);
    await svc.complete(state, state, "code");
    expect(auth.oidcSignIn).toHaveBeenCalledWith(ID, "abc", null, false);
  });

  it("rejects a callback from a browser that did not start the flow", async () => {
    const { svc } = makeService();
    const idp = stubProvider((nonce) => rs256({ sub: "abc", nonce }));
    const { state } = await idp.begin(svc);
    await expect(svc.complete(state, "other", "code")).rejects.toThrow(/another browser/);
    // The state is spent either way.
    await expect(svc.complete(state, state, "code")).rejects.toThrow();
  });

  it("rejects tokens for another client, with the wrong nonce, or signed by someone else", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    for (const idToken of [
      (nonce: string) => rs256({ sub: "abc", nonce }, { audience: "someone-else" }),
      () => rs256({ sub: "abc", nonce: "stale" }),
      (nonce: string) => jwt.sign({ sub: "abc", nonce }, other, { algorithm: "RS256", keyid: "k1", issuer: ISSUER, audience: "palisade" }),
      (nonce: string) => jwt.sign({ sub: "abc", nonce }, "", { algorithm: "none", issuer: ISSUER, audience: "palisade" }),
    ]) {
      const { svc, auth } = makeService();
      const idp = stubProvider(idToken);
      const { state } = await idp.begin(svc);
      await expect(svc.complete(state, state, "code")).rejects.toThrow();
      expect(auth.oidcSignIn).not.toHaveBeenCalled();
    }
  });

  it("maps groups to the highest role and turns away users in none", async () => {
    const groups = { [SettingKeys.OidcAdminGroup]: "palisade-admins", [SettingKeys.OidcViewerGroup]: "gamers" };
    const { svc, auth } = makeService(groups);
    let memberOf: string[] = ["gamers", "palisade-admins"];
    const idp = stubProvider((nonce) => rs256({ sub: "abc", preferred_username: "magnus", groups: memberOf, nonce }));
    let { state } = await idp.begin(svc);
    await svc.complete(state, state, "code");
    expect(auth.oidcSignIn).toHaveBeenLastCalledWith(ID, "magnus", "admin", false);

    memberOf = ["someone-else"];
    ({ state } = await idp.begin(svc));
    await expect(svc.complete(state, state, "code")).rejects.toThrow(/not in any group/);
    expect(auth.oidcRevoke).toHaveBeenCalledWith(ID);
  });

  it("passes the role the groups grant to a link, and never signs out the linking user", async () => {
    const { svc, auth } = makeService({ [SettingKeys.OidcOperatorGroup]: "ops" });
    let memberOf = ["ops"];
    const idp = stubProvider((nonce) => rs256({ sub: "abc", groups: memberOf, nonce }));
    let { state } = await idp.begin(svc, "user-1");
    await svc.complete(state, state, "code");
    expect(auth.linkOidc).toHaveBeenCalledWith("user-1", ID, "operator");

    memberOf = [];
    ({ state } = await idp.begin(svc, "user-1"));
    await expect(svc.complete(state, state, "code")).rejects.toThrow(/not in any group/);
    expect(auth.oidcRevoke).not.toHaveBeenCalled();
  });

  it("reads groups from the configured claim", async () => {
    const { svc, auth } = makeService({
      [SettingKeys.OidcOperatorGroup]: "ops",
      [SettingKeys.OidcGroupsClaim]: "realm_access.roles",
    });
    const idp = stubProvider((nonce) => rs256({ sub: "abc", realm_access: { roles: ["ops"] }, groups: ["x"], nonce }));
    const { state } = await idp.begin(svc);
    await svc.complete(state, state, "code");
    expect(auth.oidcSignIn).toHaveBeenCalledWith(ID, "abc", "operator", false);
  });

  it("lets SSO create accounts only when the admin allows it", async () => {
    const { svc, auth } = makeService({ [SettingKeys.OidcAutoCreate]: "true" });
    const idp = stubProvider((nonce) => rs256({ sub: "abc", nonce }));
    const { state } = await idp.begin(svc);
    await svc.complete(state, state, "code");
    expect(auth.oidcSignIn).toHaveBeenCalledWith(ID, "abc", null, true);
  });

  it("reuses the provider's discovery document and keys until a new key id appears", async () => {
    const { svc } = makeService();
    const idp = stubProvider((nonce) => rs256({ sub: "abc", nonce }, { keyid: idp.jwks.kid }));
    for (let i = 0; i < 2; i++) {
      const { state } = await idp.begin(svc);
      await svc.complete(state, state, "code");
    }
    const count = (suffix: string) => idp.fetched.filter((u) => u.endsWith(suffix)).length;
    expect([count("/openid-configuration"), count("/jwks/")]).toEqual([1, 1]);

    idp.jwks.kid = "k2";
    const { state } = await idp.begin(svc);
    await svc.complete(state, state, "code");
    expect(count("/jwks/")).toBe(2);
  });

  it("links the identity to the user who started a link flow", async () => {
    const { svc, auth } = makeService();
    const idp = stubProvider((nonce) => rs256({ sub: "abc", nonce }));
    const { state } = await idp.begin(svc, "user-1");
    expect(svc.isLinkFlow(state)).toBe(true);
    expect(await svc.complete(state, state, "code")).toEqual({ linked: true });
    expect(auth.linkOidc).toHaveBeenCalledWith("user-1", ID, null);
    expect(auth.oidcSignIn).not.toHaveBeenCalled();
  });
});

describe("roleForGroups", () => {
  it("picks the highest mapped role and ignores unset groups", () => {
    const mapping = { admin: "a", operator: "o", viewer: null };
    expect(roleForGroups(["o", "a"], mapping)).toBe("admin");
    expect(roleForGroups(["o"], mapping)).toBe("operator");
    expect(roleForGroups(["x"], mapping)).toBeNull();
  });
});

describe("readGroups", () => {
  it("reads the claim shapes providers actually send", () => {
    expect(readGroups({ groups: ["a", "b", 3] }, "groups")).toEqual(["a", "b"]);
    expect(readGroups({ groups: "a" }, "groups")).toEqual(["a"]);
    // Keycloak realm roles
    expect(readGroups({ realm_access: { roles: ["ops"] } }, "realm_access.roles")).toEqual(["ops"]);
    // Auth0 namespaced claim: the dots are part of the name
    expect(readGroups({ "https://example.com/roles": ["ops"] }, "https://example.com/roles")).toEqual(["ops"]);
    // Zitadel keys roles by name
    const zitadel = { "urn:zitadel:iam:org:project:roles": { ops: { "123": "example.com" } } };
    expect(readGroups(zitadel, "urn:zitadel:iam:org:project:roles")).toEqual(["ops"]);
    expect(readGroups({}, "groups")).toEqual([]);
    expect(readGroups({ realm_access: null }, "realm_access.roles")).toEqual([]);
  });
});
