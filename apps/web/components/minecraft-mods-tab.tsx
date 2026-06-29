"use client";
import { Boxes, Info } from "lucide-react";

/**
 * Placeholder for Minecraft mods. Minecraft doesn't use Steam Workshop or the ARK
 * CurseForge browser — mods/plugins come from CurseForge/Modrinth modpacks, which
 * the itzg image installs from a pack URL or a dropped jar. That richer flow isn't
 * wired up yet; this sets expectations instead of showing a broken browser.
 */
export function MinecraftModsTab() {
  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <Boxes className="h-5 w-5 text-ark-accent" />
        <h3 className="font-semibold text-slate-100">Mods &amp; plugins</h3>
      </div>
      <p className="text-sm text-slate-400">
        Minecraft mod management is coming next. Choose the server flavour under{" "}
        <span className="font-mono text-slate-300">Settings → Server → Server type</span> (Paper/Spigot for
        plugins, Fabric/Forge/NeoForge for mods); modpack and jar installs will land here.
      </p>
      <div className="flex items-start gap-2 rounded-md border border-ark-border bg-ark-bg px-3 py-2 text-xs text-slate-500">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          For now, drop mod/plugin jars into the instance&apos;s{" "}
          <span className="font-mono">mods/</span> or <span className="font-mono">plugins/</span> folder on the
          host and restart the server.
        </span>
      </div>
    </div>
  );
}
