"use client";
import { useMemo, useRef, useState } from "react";

/**
 * A compact single-series sparkline (change-over-time under a metric tile).
 * One series per plot — identity comes from the tile's label, so no legend; the
 * line is a thin 2px stroke in the app accent, grid-free at this scale. Hover
 * shows a crosshair + the sample's value and time (the value text stays in ink
 * color, not the series color). Nulls (e.g. samples while the query was
 * unanswered) break the line rather than faking zeros.
 */
export function Sparkline({
  points,
  format,
  height = 36,
  emptyLabel = "collecting…",
}: {
  /** Chronological samples; null = unknown at that instant. */
  points: { at: string; value: number | null }[];
  /** Format a value for the hover readout (e.g. v => `${v}%`). */
  format?: (v: number) => string;
  height?: number;
  /** Shown instead of the line while no sample has a value. */
  emptyLabel?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null); // sample index
  const W = 100; // viewBox width; the svg scales to its container

  const { path, ys, min, max } = useMemo(() => {
    const vals = points.map((p) => p.value).filter((v): v is number => v != null);
    const lo = vals.length ? Math.min(...vals) : 0;
    const hi = vals.length ? Math.max(...vals) : 1;
    const span = hi - lo || 1;
    const n = Math.max(points.length - 1, 1);
    // 2px padding top/bottom so the stroke never clips.
    const y = (v: number) => 2 + (height - 4) * (1 - (v - lo) / span);
    const ys = points.map((p) => (p.value == null ? null : y(p.value)));
    let d = "";
    let pen = false;
    ys.forEach((yv, i) => {
      if (yv == null) {
        pen = false;
        return;
      }
      const x = (i / n) * W;
      d += pen ? ` L${x.toFixed(2)},${yv.toFixed(2)}` : `M${x.toFixed(2)},${yv.toFixed(2)}`;
      pen = true;
    });
    return { path: d, ys, min: lo, max: hi };
  }, [points, height]);

  if (points.length < 2 || !path) {
    return <div className="h-9 text-[10px] leading-9 text-slate-600">{emptyLabel}</div>;
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * (points.length - 1)));
  };

  const h = hover != null ? points[hover] : null;
  const hx = hover != null ? (hover / Math.max(points.length - 1, 1)) * W : 0;
  const fmt = format ?? ((v: number) => String(Math.round(v)));

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="h-9 w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <path d={path} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" className="stroke-ark-accent" />
        {h && ys[hover!] != null && (
          <>
            <line x1={hx} x2={hx} y1={0} y2={height} strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-slate-600" />
            <circle cx={hx} cy={ys[hover!]!} r={2.5} className="fill-ark-accent" />
          </>
        )}
      </svg>
      {/* Readout in ink color (never the series color); min–max gives the y-scale. */}
      <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-slate-500">
        {h && h.value != null ? (
          <span className="text-slate-300">
            {fmt(h.value)} · {new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        ) : (
          <span>last hour</span>
        )}
        <span>
          {fmt(min)}–{fmt(max)}
        </span>
      </div>
    </div>
  );
}
