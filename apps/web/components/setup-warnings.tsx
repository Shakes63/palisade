"use client";
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { apiGet } from "@/lib/api";
import { useRole } from "@/lib/use-role";

interface Health {
  status: string;
  warnings?: string[];
}

/**
 * Host-setup problems Palisade can detect but not fix for you — the manager sitting
 * off ark-net, or a HOST_DATA_DIR that disagrees with the real /data mount.
 *
 * These were already reported by GET /api/health, which is not somewhere a panel
 * user would ever think to look: the #31 reporter had to be told the fix in the
 * issue thread, and asked for exactly this ("maybe put a reminder inside the
 * Overview"). Admin-only, since every warning here names a host-level action only
 * an admin can take.
 */
export function SetupWarnings() {
  const role = useRole();
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    if (role !== "admin") return;
    let cancelled = false;
    apiGet<Health>("/health")
      .then((h) => {
        if (!cancelled) setWarnings(h.warnings ?? []);
      })
      .catch(() => undefined); // never let a health hiccup break the page
    return () => {
      cancelled = true;
    };
  }, [role]);

  if (role !== "admin" || warnings.length === 0) return null;

  return (
    <div className="space-y-2">
      {warnings.map((w, i) => (
        <div key={i} className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-200">
                Setup needs attention
              </h3>
              <p className="mt-1 text-sm leading-snug text-amber-100/90">{w}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
