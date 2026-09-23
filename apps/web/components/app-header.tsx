"use client";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { usePathname } from "next/navigation";
import { LogOut, Boxes, Settings } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useRole } from "@/lib/use-role";

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-1 ${active ? "text-slate-100" : "hover:text-slate-200"}`}
    >
      {children}
    </Link>
  );
}

export function AppHeader() {
  const { token, logout } = useAuth();
  const role = useRole();
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/setup") return null;

  return (
    <header className="border-b border-ark-border bg-ark-panel">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-4 sm:gap-6">
          <Link href="/" className="flex items-center gap-2 font-semibold text-slate-100" title="Palisade" aria-label="Palisade">
            <Logo className="h-6 w-6" />
            <span className="hidden sm:inline">Palisade</span>
          </Link>
          {token && (
            <nav className="flex items-center gap-4 text-sm text-slate-400">
              <NavLink href="/" active={pathname === "/" || pathname.startsWith("/servers/")}>
                Servers
              </NavLink>
              <NavLink href="/clusters" active={pathname.startsWith("/clusters")}>
                <Boxes className="hidden h-4 w-4 sm:block" /> Clusters
              </NavLink>
              {role === "admin" && (
                <NavLink href="/settings" active={pathname.startsWith("/settings")}>
                  <Settings className="hidden h-4 w-4 sm:block" /> Settings
                </NavLink>
              )}
            </nav>
          )}
        </div>
        {token && (
          <button onClick={logout} className="btn-secondary" title="Sign out" aria-label="Sign out">
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        )}
      </div>
    </header>
  );
}
