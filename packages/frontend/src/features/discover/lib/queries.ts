import { useQuery } from "@tanstack/react-query";
import { serializeFilters, type Filters } from "@/features/images/lib/imageFilter";
import { fetchRandomImages, IMAGE_PICKS_PREFIX } from "@/features/images/lib/imageApi";
import type { FeedItem } from "@/features/images/lib/imageFilter";

/** Every Discover pick's key starts with this (under the picks prefix, so
 * the image view's edits patch the cached tiles). */
const DISCOVER_KEY = [...IMAGE_PICKS_PREFIX, "discover"] as const;

// Quarantined in the image view after the pick: off the shelf. (A pick never
// includes one, so only such a change can bring one here.)
const visible = (rows: FeedItem[]) => (rows.some((r) => r.quarantined) ? rows.filter((r) => !r.quarantined) : rows);

/** Images per strip: two rows at the widest grid. */
export const STRIP_SIZE = 12;

/**
 * `limit` random images `filters` matches. One pick per `deal`: the same
 * images until the deal changes, so coming back to the page shows what was
 * there, and a new deal is a new pick. While a new deal of the same filter
 * loads, the last one stays on screen (no placeholders between two sets of
 * images); a new filter (another character) starts empty.
 */
export function useRandomImages(filters: Filters | null, deal: number, limit = STRIP_SIZE) {
  const filterKey = filters ? serializeFilters(filters).toString() : null;
  return useQuery({
    queryKey: [...DISCOVER_KEY, filterKey, limit, deal],
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[DISCOVER_KEY.length] === filterKey ? previous : undefined,
    queryFn: () => fetchRandomImages(filters!, limit),
    enabled: filters != null,
    staleTime: Infinity,
    select: visible,
  });
}
