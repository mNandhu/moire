import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { TAGS_KEY, useTagBrowse, type Sample } from "./queries";

/**
 * Coalesces calls made in the same tick into one request. `fetchMany` gets
 * the distinct ids asked for and answers by id; every caller gets its own
 * entry (undefined when absent), or the failure of the whole batch.
 */
export function createBatcher<T>(
  fetchMany: (ids: string[]) => Promise<Record<string, T>>,
  schedule: (flush: () => void) => void = (f) => void setTimeout(f, 0),
): (id: string) => Promise<T | undefined> {
  type Waiter = { resolve: (v: T | undefined) => void; reject: (e: unknown) => void };
  let pending = new Map<string, Waiter[]>();
  const flush = () => {
    const batch = pending;
    pending = new Map();
    fetchMany([...batch.keys()]).then(
      (res) => batch.forEach((ws, id) => ws.forEach((w) => w.resolve(res[id]))),
      (err) => batch.forEach((ws) => ws.forEach((w) => w.reject(err))),
    );
  };
  return (id) =>
    new Promise((resolve, reject) => {
      if (!pending.size) schedule(flush);
      const ws = pending.get(id) ?? [];
      ws.push({ resolve, reject });
      pending.set(id, ws);
    });
}

const batchers = new Map<number, ReturnType<typeof createBatcher<Sample[]>>>();
function samplesBatcher(per: number) {
  let b = batchers.get(per);
  if (!b) {
    b = createBatcher<Sample[]>((ids) => {
      const params = new URLSearchParams({ per: String(per) });
      ids.forEach((id) => params.append("tags", id));
      return api<Record<string, Sample[]>>(`/api/v1/tags/samples?${params}`);
    });
    batchers.set(per, b);
  }
  return b;
}

/** The query for one tag's samples; every reader of it (a card, the hover
 * card, the prompt board) shares the cache entry and the grid's batching. */
export const tagSamplesQuery = (id: string, per = 4, staleTime = 0) => ({
  queryKey: [...TAGS_KEY, "samples", id, per],
  queryFn: async () => (await samplesBatcher(per)(id)) ?? [],
  staleTime,
});

/**
 * A few library images for a tag (`any:tag`, `all:tag` or a plain tag id as
 * the Tags page spells them), shuffled, one image per batch while it can.
 * Under TAGS_KEY, so pinning a new cover refreshes it.
 */
export function useTagSamples(id: string, per = 4, { enabled = true, staleTime = 0 } = {}) {
  return useQuery({ ...tagSamplesQuery(id, per, staleTime), enabled });
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
