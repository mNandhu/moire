import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_DENSITY,
  DENSITY_STEPS,
  targetTileWidth,
} from "../lib/masonryLayout";

const KEY = "gallery:density";

function readStored(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_DENSITY;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_DENSITY;
    return Math.max(0, Math.min(DENSITY_STEPS.length - 1, Math.round(n)));
  } catch {
    // Private mode / storage disabled: fall back rather than crashing the grid.
    return DEFAULT_DENSITY;
  }
}

/**
 * Gallery zoom, persisted across sessions.
 *
 * Deliberately localStorage and not the URL: density is a view preference, not
 * a filter. Routing it through imageFilter.ts would put it in the feed's query
 * key, so every zoom step would refetch the feed and blow the cursor pages
 * away, the grid already has the images, it just wants them smaller.
 */
export function useDensity() {
  const [density, setDensity] = useState<number>(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(density));
    } catch {
      // Non-fatal; the preference just won't survive a reload.
    }
  }, [density]);

  const zoomIn = useCallback(
    () => setDensity((d) => Math.max(0, d - 1)),
    [],
  );
  const zoomOut = useCallback(
    () => setDensity((d) => Math.min(DENSITY_STEPS.length - 1, d + 1)),
    [],
  );

  return {
    density,
    setDensity,
    zoomIn,
    zoomOut,
    /** True at the coarsest / densest end, for disabling the zoom buttons. */
    atMin: density <= 0,
    atMax: density >= DENSITY_STEPS.length - 1,
    targetWidth: targetTileWidth(density),
  };
}
