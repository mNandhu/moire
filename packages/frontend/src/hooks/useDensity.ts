import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_DENSITY,
  DENSITY_STEPS,
  PHONE_DEFAULT_DENSITY,
  PHONE_MAX_WIDTH,
  targetTileWidth,
} from "../lib/masonryLayout";

const KEY = "gallery:density";

/** Nothing stored yet: two columns on a phone, the usual targets elsewhere. */
function fallback(): number {
  const phone = window.matchMedia?.(`(max-width: ${PHONE_MAX_WIDTH - 1}px)`)?.matches;
  return phone ? PHONE_DEFAULT_DENSITY : DEFAULT_DENSITY;
}

function readStored(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return fallback();
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback();
    return Math.max(0, Math.min(DENSITY_STEPS.length - 1, Math.round(n)));
  } catch {
    // Private mode / storage disabled: fall back rather than crashing the grid.
    return fallback();
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
  // Saved only once someone zooms: persisting the fallback on mount would pin
  // a phone's default onto the same browser later opened wide, and the other
  // way round.
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current) return;
    try {
      localStorage.setItem(KEY, String(density));
    } catch {
      // Non-fatal; the preference just won't survive a reload.
    }
  }, [density]);

  const zoomIn = useCallback(() => {
    touched.current = true;
    setDensity((d) => Math.max(0, d - 1));
  }, []);
  const zoomOut = useCallback(() => {
    touched.current = true;
    setDensity((d) => Math.min(DENSITY_STEPS.length - 1, d + 1));
  }, []);

  return {
    density,
    zoomIn,
    zoomOut,
    /** True at the coarsest / densest end, for disabling the zoom buttons. */
    atMin: density <= 0,
    atMax: density >= DENSITY_STEPS.length - 1,
    targetWidth: targetTileWidth(density),
  };
}
