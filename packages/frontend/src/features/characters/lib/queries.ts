// The character list: every character in the library, shared by the image
// view, character pages, the Generate screen and the search palette.

import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CharacterEntry } from "./character";
import { TAGS_KEY } from "@/features/tags/lib/queries";

const charactersQuery = {
  queryKey: [...TAGS_KEY, "characters"],
  queryFn: ({ signal }: { signal: AbortSignal }) => api<CharacterEntry[]>("/api/v1/tags/characters", { signal }),
  staleTime: 60_000,
};

/** Every character in the library; shared by the image view and character pages. */
export function useCharacters() {
  return useQuery(charactersQuery);
}

/** Loads the characters at startup: a cold list takes the server a second or
 * more, and the first image opened shouldn't wait on it. Not at once: on
 * boot it held a connection the gallery's first page and thumbnails wanted. */
export function usePrefetchCharacters() {
  const qc = useQueryClient();
  useEffect(() => {
    // A second in, then idle: the page sits idle while the first page is
    // on the wire, so idle alone came too soon.
    const load = () => void qc.prefetchQuery(charactersQuery);
    let idle = 0;
    const timer = setTimeout(() => {
      if (typeof requestIdleCallback === "function") idle = requestIdleCallback(load, { timeout: 2000 });
      else load();
    }, 1000);
    return () => {
      clearTimeout(timer);
      if (idle) cancelIdleCallback(idle);
    };
  }, [qc]);
}

/** Every character by each of its names (a bare alias included). */
export function useCharacterLookup(): Map<string, CharacterEntry> {
  const { data } = useCharacters();
  return useMemo(
    () => new Map((data ?? []).flatMap((c) => [c.tag, ...c.aliases].map((n) => [n, c] as const))),
    [data],
  );
}
