import { ArrowUpCircle } from "lucide-react";

/** Shown when a newer server build is available than the one installed. */
export function UpdateBadge({ className = "" }: { className?: string }) {
  return (
    <span
      title="A newer game build is available — hit Update game to apply it (the image downloads it on the next boot)"
      className={`inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400 ${className}`}
    >
      <ArrowUpCircle className="h-3.5 w-3.5" /> Update available
    </span>
  );
}
