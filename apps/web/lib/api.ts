const TOKEN_KEY = "ark.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The parsed JSON error body, when present — e.g. the start guard's
     *  InsufficientRamInfo (code "INSUFFICIENT_RAM"). */
    public body?: unknown,
  ) {
    super(message);
  }
}

/**
 * When an authenticated request comes back 401, the stored token is expired/invalid
 * — clear it and bounce to the login screen so the user re-authenticates cleanly
 * (rather than getting a raw "invalid or expired token" alert on every action). We
 * only do this when a token was actually sent: a 401 with no token is a login
 * attempt (bad credentials), which the login form should surface itself. Auth routes
 * are exempt so a failed /auth/login doesn't trigger a redirect loop.
 */
function handleAuthFailure(status: number, path: string): void {
  if (status !== 401 || !getToken() || path.startsWith("/auth/")) return;
  clearToken();
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    handleAuthFailure(res.status, path);
    let message = res.statusText;
    let body: unknown;
    try {
      body = await res.json();
      message = (body as { message?: string }).message ?? message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, Array.isArray(message) ? message.join(", ") : message, body);
  }
  if (res.status === 204) return undefined as T;
  // Some endpoints (start/stop/restart) return an empty body — read as text and
  // only parse when there's something, so an empty 200/201 isn't a JSON error.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const apiGet = <T>(path: string) => api<T>(path);
export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
export const apiPatch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const apiPut = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
export const apiDelete = <T>(path: string) => api<T>(path, { method: "DELETE" });

/** Multipart file upload — must NOT set Content-Type (the browser adds the
 *  multipart boundary itself). Field name is "file" (matches FileInterceptor). */
export async function apiUpload<T = unknown>(path: string, file: File): Promise<T> {
  const token = getToken();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
  });
  if (!res.ok) {
    handleAuthFailure(res.status, path);
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.message ?? message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, Array.isArray(message) ? message.join(", ") : message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
