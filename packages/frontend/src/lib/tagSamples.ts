import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Sample } from "../components/TagMosaic";
import { api } from "./api";
import { TAGS_KEY, useTagBrowse } from "./queries";

/**
 * A few library images for a tag (`any:tag`, `all:tag` or a plain tag id as
 * the Tags page spells them), shuffled, one image per batch while it can.
 * Under TAGS_KEY, so pinning a new cover refreshes it.
 */
export function useTagSamples(id: string, per = 4, { enabled = true, staleTime = 0 } = {}) {
  return useQuery({
    queryKey: [...TAGS_KEY, "samples", id, per],
    queryFn: ({ signal }) =>
      api<Record<string, Sample[]>>(`/api/v1/tags/samples?${new URLSearchParams({ tags: id, per: String(per) })}`, { signal }).then(
        (r) => r[id] ?? [],
      ),
    enabled,
    staleTime,
  });
}

/**
 * Each tag's cover, for suggestion lists. They come from the Tags page list,
 * a big one, so it is only fetched once `enabled`. Returns a lookup by tag.
 */
export function useTagCovers(enabled: boolean) {
  const { data } = useTagBrowse("all", { enabled });
  const thumbs = useMemo(() => new Map((data ?? []).map((b) => [b.tag, b.thumb_url])), [data]);
  return useCallback((id: string) => thumbs.get(id) ?? null, [thumbs]);
}
