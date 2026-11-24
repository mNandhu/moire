import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { TAGS_KEY } from "@/features/tags/lib/queries";

export type CharacterMade = { tag: string; count: number; image_ids?: string[] };

/**
 * The characters in the images made from `since` to before `until` (epoch
 * seconds), most images first, each by its character page's key. Under the
 * tag keys, so a tag edit refreshes it. `withIds`: each one's image ids too.
 * Idle while `since` is null.
 */
export function useCharactersMade(since: number | null, until: number | null, limit = 12, withIds = false) {
  return useQuery({
    queryKey: [...TAGS_KEY, "characters-made", since, until, limit, withIds],
    queryFn: ({ signal }) => {
      const sp = new URLSearchParams({ since: String(since), limit: String(limit) });
      if (withIds) sp.set("ids", "1");
      if (until != null) sp.set("until", String(until));
      return api<CharacterMade[]>(`/api/v1/tags/characters/made?${sp}`, { signal });
    },
    enabled: since != null,
    staleTime: 60_000,
    // A new image moves a session's end: keep the last answer while the new
    // one comes, rather than blank what it named.
    placeholderData: keepPreviousData,
  });
}
