import { useLayoutEffect, useRef, useState } from "react";
import {
  columnWidth,
  gapForDensity,
  gridColumns,
  DEFAULT_DENSITY,
} from "../lib/masonryLayout";

/**
 * Placeholder masonry shown while the first page of the feed is in flight.
 *
 * The gallery used to render nothing at all in this window: the grid was gated
 * on `items.length > 0` and the empty state on `!isLoading`, so between them
 * sat a blank screen that read as "broken" rather than "loading"; worst on a
 * cold backend, which is exactly when it showed longest.
 *
 * Shapes vary in height on a fixed cycle rather than randomly, so the skeleton
 * looks like a masonry grid and doesn't reshuffle on every render.
 */
const HEIGHT_CYCLE = [1.35, 1.0, 1.5, 0.75, 1.2, 1.6, 0.9, 1.1];

export function GallerySkeleton({
  density = DEFAULT_DENSITY,
  rows = 3,
}: {
  density?: number;
  /** Roughly how many rows to fill, enough to reach the fold. */
  rows?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Layout effect so the skeleton is sized in the first painted frame rather
  // than flashing empty for one; the same measure-after-paint gap the grid had.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const gap = gapForDensity(density);
  const cols = gridColumns(width, density);
  const colW = columnWidth(width, cols, gap);
  const count = cols * rows;

  return (
    <div ref={ref} aria-hidden="true" className="w-full">
      {width > 0 && (
        <div
          className="flex items-start"
          style={{ gap: `${gap}px` }}
        >
          {Array.from({ length: cols }, (_, c) => (
            <div
              key={c}
              className="flex flex-col"
              style={{ gap: `${gap}px`, width: `${colW}px` }}
            >
              {Array.from({ length: Math.ceil(count / cols) }, (_, r) => {
                const h = colW * HEIGHT_CYCLE[(c + r * cols) % HEIGHT_CYCLE.length];
                return (
                  <div
                    key={r}
                    className="relative overflow-hidden rounded-xl bg-neutral-800/50"
                    style={{ height: `${Math.round(h)}px` }}
                  >
                    {/* Sweeping highlight: the same `shimmer` keyframe the
                        design system already defines, finally used. */}
                    <div className="absolute inset-0 -translate-x-full motion-safe:animate-shimmer bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
