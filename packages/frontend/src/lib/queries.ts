/**
 * Shared server-state queries for data more than one page reads.
 *
 * Overview, Libraries, Tags and the gallery each used to fetch libraries and
 * the tag aggregate in their own `useEffect` into local state, so every visit
 * started from nothing and flashed a loading state. Reading them through one
 * TanStack cache makes moving between pages instant and keeps them in step:
 * a write invalidates the key once and every reader refreshes.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type Library = {
  _id: string;
  name?: string;
  path: string;
  indexed_count?: number;
  last_scanned?: string;
  watch_enabled?: boolean;
  last_event_at?: string | null;
  scanning?: boolean;
};

export const LIBRARIES_KEY = ["libraries"] as const;

export function fetchLibraries(signal?: AbortSignal): Promise<Library[]> {
  return api<Library[]>("/api/v1/libraries", { signal });
}

/** All libraries; polls while any of them is scanning so counts stay live. */
export function useLibraries() {
  return useQuery({
    queryKey: LIBRARIES_KEY,
    queryFn: ({ signal }) => fetchLibraries(signal),
    refetchInterval: (q) =>
      q.state.data?.some((l) => l.scanning) ? 3000 : false,
  });
}

export type TagAgg = { _id: string; count: number };

/** Prefix for every tag-aggregate query; invalidate this after tag writes. */
export const TAGS_KEY = ["tags"] as const;

/**
 * The tag aggregate (AI + manual, optionally prompt tags). The backend caches
 * this for ~30s, so the default staleTime matches it.
 */
export function useTagAggregate({ includePrompt = false } = {}) {
  return useQuery({
    queryKey: [...TAGS_KEY, { includePrompt }],
    queryFn: ({ signal }) =>
      api<TagAgg[]>(
        `/api/v1/tags?include_manual=1${includePrompt ? "&include_prompt=1" : ""}`,
        { signal },
      ),
  });
}
