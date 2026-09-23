"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { apiGet, apiPost, clearToken, getToken, setToken } from "./api";

interface AuthState {
  token: string | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthCtx = createContext<AuthState | null>(null);
const PUBLIC_ROUTES = ["/login", "/setup"];

/** Where this visitor belongs instead of `pathname`, or null when they may stay. */
function authRedirect(initialized: boolean, signedIn: boolean, pathname: string): string | null {
  if (!initialized) return pathname === "/setup" ? null : "/setup";
  if (signedIn) return PUBLIC_ROUTES.includes(pathname) ? "/" : null;
  return pathname === "/login" ? null : "/login";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<{ initialized: boolean; path: string } | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Only first-run completes an install, so a true answer never needs asking again.
    if (status?.initialized) return;
    apiGet<{ initialized: boolean }>("/auth/status")
      .then((s) => setStatus({ initialized: s.initialized, path: pathname }))
      .catch(() => setStatus({ initialized: true, path: pathname }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // A "not initialised" answer is re-checked per route, so finishing setup can't bounce back to it.
  const initialized = status && (status.initialized || status.path === pathname) ? status.initialized : null;
  // Read on every render: login, setup and logout all change the route, which re-renders here.
  const token = initialized === null ? null : getToken();
  const redirect = initialized === null ? null : authRedirect(initialized, token !== null, pathname);
  const ready = initialized !== null && redirect === null;

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  const login = async (username: string, password: string) => {
    const { token } = await apiPost<{ token: string }>("/auth/login", { username, password });
    setToken(token);
    router.replace("/");
  };

  const logout = () => {
    clearToken();
    router.replace("/login");
  };

  return (
    <AuthCtx.Provider value={{ token, ready, login, logout }}>{ready ? children : null}</AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
