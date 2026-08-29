"use client";
import { useEffect, useState } from "react";
import type { Role } from "@ark/shared";
import { getToken } from "./api";
import { useAuth } from "./auth";

/** Role from the stored JWT (display gating only — the API enforces for real).
 *  Legacy tokens without a role claim were single-admin installs. */
export function roleFromToken(): Role {
  const token = getToken();
  if (!token) return "viewer";
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? "")) as { role?: Role };
    return payload.role ?? "admin";
  } catch {
    return "viewer";
  }
}

/**
 * SSR-safe hook: renders as viewer until mounted, then the token's role.
 *
 * Re-derived whenever the auth token changes, NOT once on mount. AppHeader lives in
 * the layout and mounts a single time — on /login, before there is a token — so a
 * mount-only read left every freshly logged-in admin sitting at role "viewer" until
 * they happened to reload the page. Since /login renders no nav, the visible symptom
 * was the Settings link simply missing for admins, while Servers and Clusters (gated
 * on the token, which does update) were there.
 *
 * Keying off the token also covers logging out and back in as a different user, where
 * the previous session's role would otherwise persist.
 */
export function useRole(): Role {
  const [role, setRole] = useState<Role>("viewer");
  const { token } = useAuth();
  useEffect(() => setRole(roleFromToken()), [token]);
  return role;
}
