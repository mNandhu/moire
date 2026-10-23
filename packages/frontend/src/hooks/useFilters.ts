import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { readLocalPref, writeLocalPref } from "../lib/localPref";
import { parseFilters, serializeFilters, type Filters } from "../lib/imageFilter";

const GROUP_PREF_KEY = "gallery_group_pref";

/**
 * Bind the Image filter to the URL with the URL as the single source of truth:
 * `filters` is derived from the search params, and `setFilters` writes them
 * back. No mirrored state and no sync effects, so the URL and the filter can
 * never drift. See CONTEXT.md › Frontend › Image filter.
 *
 * The `group` setting persists to localStorage: if not in the URL, the last
 * saved preference is restored.
 */
export function useFilters(): [Filters, (next: Filters) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => {
    const parsed = parseFilters(searchParams);
    // If group is not explicitly in URL, restore from localStorage
    if (!searchParams.has("group")) {
      if (readLocalPref(GROUP_PREF_KEY) === "1") {
        parsed.group = true;
      }
    }
    return parsed;
  }, [searchParams]);

  const setFilters = useCallback(
    (next: Filters) => {
      // Save group preference to localStorage whenever it changes
      writeLocalPref(GROUP_PREF_KEY, next.group ? "1" : "0");
      setSearchParams(serializeFilters(next), { replace: true });
    },
    [setSearchParams],
  );
  return [filters, setFilters];
}
