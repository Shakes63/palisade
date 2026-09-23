"use client";
import { BookOpen } from "lucide-react";
import type { Game } from "@ark/shared";
import { GAME_DOCS } from "@/lib/game-docs.generated";
import { MarkdownLite } from "@/components/markdown-lite";

/**
 * The per-game guide from docs/games/, bundled into the app at build time —
 * image credit, ports, joining, first-boot expectations, and the gotchas we
 * hit live-verifying the game. Same content as the repo docs.
 */
export function GuideTab({ game }: { game: Game }) {
  const doc = GAME_DOCS[game];
  if (!doc) {
    return <p className="card text-sm text-slate-400">No guide for this game yet.</p>;
  }
  return (
    <div className="card max-w-3xl">
      <MarkdownLite source={doc} />
      <p className="mt-5 flex items-center gap-1.5 border-t border-ark-border/50 pt-3 text-[11px] text-slate-500">
        <BookOpen className="h-3.5 w-3.5" />
        Also in the repo under docs/games — updated with each release.
      </p>
    </div>
  );
}
