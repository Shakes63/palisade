"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { apiGet, apiPost, clearToken, getToken, setToken } from "./api";

interface SsoOptions {
  sso: boolean;
  ssoOnly: boolean;
  ssoAutoRedirect: boolean;
}

interface AuthState extends SsoOptions {
  token: string | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  /** Finish an SSO sign-in with the one-time ticket the API's callback handed back. */
  loginWithSso: (ticket: string) => Promise<void>;
  logout: () => void;
}

const AuthCtx = createContext<AuthState | null>(null);
const NO_SSO: SsoOptions = { sso: false, ssoOnly: false, ssoAutoRedirect: false };
const PUBLIC_ROUTES = ["/login", "/setup"];

/** Where this visitor belongs instead of `pathname`, or null when they may stay. */
function authRedirect(initialized: boolean, signedIn: boolean, pathname: string): string | null {
  if (!initialized) return pathname === "/setup" ? null : "/setup";
  if (signedIn) return PUBLIC_ROUTES.includes(pathname) ? "/" : null;
  return pathname === "/login" ? null : "/login";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<{ initialized: boolean; path: string } | null>(null);
  const [sso, setSso] = useState(NO_SSO);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Only first-run completes an install, so a true answer never needs asking again; the login page
    // still asks, so it offers SSO as currently configured.
    if (status?.initialized && pathname !== "/login") return;
    apiGet<{ initialized: boolean } & Partial<SsoOptions>>("/auth/status")
      .then((s) => {
        setSso({ sso: s.sso === true, ssoOnly: s.ssoOnly === true, ssoAutoRedirect: s.ssoAutoRedirect === true });
        setStatus({ initialized: s.initialized, path: pathname });
      })
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

  const loginWithSso = async (ticket: string) => {
    const { token } = await apiPost<{ token: string }>("/auth/oidc/exchange", { ticket });
    setToken(token);
    router.replace("/");
  };

  const logout = () => {
    clearToken();
    // Tells the login page not to auto-start SSO, which the provider's session would sign straight back in.
    router.replace("/login?signed_out");
  };

  return (
    <AuthCtx.Provider value={{ ...sso, token, ready, login, loginWithSso, logout }}>{ready ? children : null}</AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
