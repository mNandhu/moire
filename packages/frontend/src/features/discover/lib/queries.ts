import { useQuery } from "@tanstack/react-query";
import { serializeFilters, type Filters } from "@/features/images/lib/imageFilter";
import { fetchRandomImages } from "@/features/images/lib/imageApi";

/** Every Discover pick's key starts with this. */
const DISCOVER_KEY = ["discover"] as const;

/** Images per strip: two rows at the widest grid. */
export const STRIP_SIZE = 12;

/**
 * `limit` random images `filters` matches. One pick per `deal`: the same
 * images until the deal changes, so coming back to the page shows what was
 * there, and a new deal is a new pick.
 */
export function useRandomImages(filters: Filters | null, deal: number, limit = STRIP_SIZE) {
  return useQuery({
    queryKey: [...DISCOVER_KEY, filters ? serializeFilters(filters).toString() : null, limit, deal],
    queryFn: () => fetchRandomImages(filters!, limit),
    enabled: filters != null,
    staleTime: Infinity,
  });
}
