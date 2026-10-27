import { useCallback, useState } from "react";
import { useLocalPref } from "./useLocalPref";
import {
  clampDensity,
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

/**
 * Gallery zoom, persisted across sessions.
 *
 * Deliberately localStorage and not the URL: density is a view preference, not
 * a filter. Routing it through imageFilter.ts would put it in the feed's query
 * key, so every zoom step would refetch the feed and blow the cursor pages
 * away, the grid already has the images, it just wants them smaller.
 */
export function useDensity() {
  // Nothing is stored until someone zooms: persisting the fallback on mount
  // would pin a phone's default onto the same browser later opened wide, and
  // the other way round.
  const [initial] = useState(fallback);
  const [density, setDensity] = useLocalPref(KEY, initial, {
    parse: (raw) => (Number.isFinite(Number(raw)) ? clampDensity(Number(raw)) : undefined),
  });

  const zoomIn = useCallback(() => {
    setDensity((d) => Math.max(0, d - 1));
  }, [setDensity]);
  const zoomOut = useCallback(() => {
    setDensity((d) => Math.min(DENSITY_STEPS.length - 1, d + 1));
  }, [setDensity]);

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
