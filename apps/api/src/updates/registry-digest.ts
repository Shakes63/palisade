import { Logger } from "@nestjs/common";

/**
 * Ask a container registry what digest a tag currently points at, so the update
 * poller can tell whether a newer image has been published.
 *
 * Needed for games whose server binary is baked into the image (IMAGE_BAKED_GAMES):
 * they have no SteamCMD appmanifest to compare build ids against, so before this the
 * update check silently did nothing for them forever (GH #26).
 *
 * Everything here is best-effort — a registry hiccup, a rate limit, or a private
 * repo just means "unknown", never a thrown error or a false "up to date".
 */

const FETCH_TIMEOUT_MS = 15_000;

/** Manifest types to accept. Modern images are multi-arch, so the index/list types
 *  matter — asking only for v2 manifests gets a 404 or the wrong digest on those. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface AuthChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

/**
 * Parse a registry's `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`
 * challenge. Registries hand out anonymous pull tokens through this, and the realm
 * differs per host (auth.docker.io, ghcr.io/token, …), so we follow the challenge
 * rather than hardcoding endpoints. Returns null for Basic/absent/malformed.
 */
export function parseAuthChallenge(header: string | null | undefined): AuthChallenge | null {
  if (!header) return null;
  const bearer = /^\s*Bearer\s+(.*)$/i.exec(header);
  if (!bearer) return null;
  const params: Record<string, string> = {};
  for (const m of (bearer[1] ?? "").matchAll(/([a-zA-Z0-9_]+)="([^"]*)"/g)) {
    if (m[1] !== undefined && m[2] !== undefined) params[m[1]] = m[2];
  }
  return params.realm ? { realm: params.realm, service: params.service, scope: params.scope } : null;
}

/** The token endpoint to call for a challenge, with service/scope preserved. */
export function tokenUrlFor(challenge: AuthChallenge): string {
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set("service", challenge.service);
  if (challenge.scope) url.searchParams.set("scope", challenge.scope);
  return url.toString();
}

/**
 * Split a Docker image repo into its registry host and path, applying Docker Hub's
 * implicit defaults: a bare "name" is "library/name" on docker.io, and "user/name"
 * is on docker.io too. A leading segment containing a dot or colon (or "localhost")
 * is a registry host.
 */
export function splitRepo(repo: string): { registry: string; path: string } {
  const [first = "", ...rest] = repo.split("/");
  if (rest.length && (first.includes(".") || first.includes(":") || first === "localhost")) {
    return { registry: first, path: rest.join("/") };
  }
  return { registry: "registry-1.docker.io", path: repo.includes("/") ? repo : `library/${repo}` };
}

/** True when both digests are known and differ — i.e. a newer image is published.
 *  Unknown on either side is NOT an update (never cry wolf on a failed lookup). */
export function digestsDiffer(local: string | null, remote: string | null): boolean {
  return Boolean(local && remote && local !== remote);
}

const logger = new Logger("RegistryDigest");

async function timedFetch(url: string, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The digest a `repo:tag` currently resolves to in its registry, or null when it
 * can't be determined. Uses HEAD so no manifest body is transferred, and follows the
 * standard anonymous-pull token dance on a 401.
 */
export async function remoteImageDigest(repo: string, tag: string): Promise<string | null> {
  const { registry, path } = splitRepo(repo);
  const url = `https://${registry}/v2/${path}/manifests/${encodeURIComponent(tag)}`;
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };

  let res = await timedFetch(url, { method: "HEAD", headers });
  if (res?.status === 401) {
    const challenge = parseAuthChallenge(res.headers.get("www-authenticate"));
    if (!challenge) return null;
    const tokenRes = await timedFetch(tokenUrlFor(challenge));
    if (!tokenRes?.ok) return null;
    const token = ((await tokenRes.json().catch(() => null)) as { token?: string; access_token?: string } | null);
    const bearer = token?.token ?? token?.access_token;
    if (!bearer) return null;
    res = await timedFetch(url, { method: "HEAD", headers: { ...headers, Authorization: `Bearer ${bearer}` } });
  }
  if (!res?.ok) {
    logger.debug(`digest lookup for ${repo}:${tag} returned ${res?.status ?? "no response"}`);
    return null;
  }
  return res.headers.get("docker-content-digest");
}
