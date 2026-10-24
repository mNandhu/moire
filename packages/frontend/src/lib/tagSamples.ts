import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useTagBrowse, type Sample } from "./queries";

/** Splits ids into runs bounded by count and by total encoded length, so a
 * request built from one stays well under a server's request-line limit. */
export function chunkIds(ids: string[], { maxIds = 40, maxChars = 4000 } = {}): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const id of ids) {
    const n = encodeURIComponent(id).length + "&tags=".length;
    if (cur.length && (cur.length >= maxIds || chars + n > maxChars)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(id);
    chars += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Coalesces calls made in the same tick into requests. `fetchMany` gets the
 * distinct ids of one chunk (see `chunkIds`) and answers by id; every caller
 * gets its own entry (undefined when absent), or the failure of its own
 * chunk only. A chunk's `signal` aborts once every caller in it has aborted.
 */
export function createBatcher<T>(
  fetchMany: (ids: string[], signal: AbortSignal) => Promise<Record<string, T>>,
  schedule: (flush: () => void) => void = (f) => void setTimeout(f, 0),
  limits?: { maxIds?: number; maxChars?: number },
): (id: string, signal?: AbortSignal) => Promise<T | undefined> {
  type Waiter = { resolve: (v: T | undefined) => void; reject: (e: unknown) => void; signal?: AbortSignal };
  let pending = new Map<string, Waiter[]>();
  const run = (batch: Map<string, Waiter[]>, ids: string[]) => {
    const waiters = ids.flatMap((id) => batch.get(id) ?? []);
    const ctl = new AbortController();
    let live = waiters.length;
    const left = () => {
      if (--live === 0) ctl.abort();
    };
    for (const w of waiters) {
      if (!w.signal) continue;
      if (w.signal.aborted) left();
      else w.signal.addEventListener("abort", left, { once: true });
    }
    const fail = (err: unknown) => waiters.forEach((w) => w.reject(err));
    try {
      fetchMany(ids, ctl.signal).then(
        (res) => ids.forEach((id) => batch.get(id)?.forEach((w) => w.resolve(res[id]))),
        fail,
      );
    } catch (err) {
      fail(err);
    }
  };
  const flush = () => {
    const batch = pending;
    pending = new Map();
    for (const ids of chunkIds([...batch.keys()], limits)) run(batch, ids);
  };
  return (id, signal) =>
    new Promise((resolve, reject) => {
      if (!pending.size) schedule(flush);
      const ws = pending.get(id) ?? [];
      ws.push({ resolve, reject, signal });
      pending.set(id, ws);
    });
}

const batchers = new Map<number, ReturnType<typeof createBatcher<Sample[]>>>();
function samplesBatcher(per: number) {
  let b = batchers.get(per);
  if (!b) {
    b = createBatcher<Sample[]>((ids, signal) => {
      const params = new URLSearchParams({ per: String(per) });
      ids.forEach((id) => params.append("tags", id));
      return api<Record<string, Sample[]>>(`/api/v1/tags/samples?${params}`, { signal });
    });
    batchers.set(per, b);
  }
  return b;
}

/**
 * Samples are not under TAGS_KEY: that is invalidated by every score or
 * keep in a viewer, which would refetch every visible mosaic. Invalidate
 * this from writes that can change them (a rename, merge, rule or cover).
 */
export const TAG_SAMPLES_KEY = ["tag-samples"] as const;

/** The query for one tag's samples; every reader of it (a card, the hover
 * card, the prompt board) shares the cache entry and the grid's batching. */
export const tagSamplesQuery = (id: string, per = 4, staleTime = 60_000) => ({
  queryKey: [...TAG_SAMPLES_KEY, id, per],
  queryFn: async ({ signal }: { signal: AbortSignal }) => (await samplesBatcher(per)(id, signal)) ?? [],
  staleTime,
});

/**
 * A few library images for a tag (`any:tag`, `all:tag` or a plain tag id as
 * the Tags page spells them), shuffled, one image per batch while it can.
 * Under TAG_SAMPLES_KEY, so pinning a new cover refreshes it.
 */
export function useTagSamples(id: string, per = 4, { enabled = true, staleTime = 60_000 } = {}) {
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
