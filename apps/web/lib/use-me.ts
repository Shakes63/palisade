"use client";
import { useEffect, useState } from "react";
import type { UserDto } from "@ark/shared";
import { apiGet } from "./api";
import { useAuth } from "./auth";

/**
 * The signed-in user as the API sees them (GET /auth/me), or null until it
 * loads. Re-fetched whenever the auth token changes, for the same reason
 * useRole keys off the token: the header mounts once on /login, before there
 * is a token, and logging out and back in as someone else must not keep the
 * old answer. Display gating only. The API filters and refuses for real.
 */
export function useMe(): UserDto | null {
  const [me, setMe] = useState<UserDto | null>(null);
  const { token } = useAuth();
  useEffect(() => {
    if (!token) {
      setMe(null);
      return;
    }
    let cancelled = false;
    apiGet<UserDto>("/auth/me")
      .then((u) => {
        if (!cancelled) setMe(u);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);
  return me;
}
