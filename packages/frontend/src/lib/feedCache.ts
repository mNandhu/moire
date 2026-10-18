/**
 * Optimistic patches to the cached Image feed, and the invalidations that
 * follow a per-image mutation.
 *
 * "Drop this image from the feed" was written twice with different mechanics:
 * ImageView patched broadly via setQueriesData while AllImagesPage patched one
 * exact key via setQueryData, so the same intent behaved differently depending
 * on which screen you were on. Broad is the correct reading. An image's score
 * or quarantine state should update wherever it is cached, not only under the
 * filter you happen to be looking at.
 *
 * See CONTEXT.md › Image feed.
 */

import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { TAGS_KEY } from "./queries";
import type { FeedPage, ImageDoc } from "./imageFilter";

/**
 * Every feed query key starts with this; TanStack matches by prefix, so it
 * reaches all cursor-paged feeds regardless of filter or page size.
 */
export const IMAGE_FEED_PREFIX = ["images"] as const;
const IMAGE_GROUPS_PREFIX = ["image-groups"] as const;

/**
 * Apply `mut` to the pages of every cached Image feed. `mut` sees each page's
 * items; the server cursors stay as they were, so an edit (even one that
 * changes a sort key) never moves where the next page starts. `mut` must
 * keep the page count.
 */
export function patchFeeds(
  qc: QueryClient,
  mut: (pages: ImageDoc[][]) => ImageDoc[][],
): void {
  qc.setQueriesData<InfiniteData<FeedPage>>(
    { queryKey: IMAGE_FEED_PREFIX },
    (old) => {
      if (!old) return old;
      const patched = mut(old.pages.map((p) => p.items));
      return {
        ...old,
        pages: old.pages.map((p, i) => ({ ...p, items: patched[i] ?? [] })),
      };
    },
  );
}

/** Replace one image wherever it appears in a cached feed. */
export function patchImageInFeeds(
  qc: QueryClient,
  id: string,
  patch: (doc: ImageDoc) => ImageDoc,
): void {
  patchFeeds(qc, (pages) =>
    pages.map((page) => page.map((doc) => (doc._id === id ? patch(doc) : doc))),
  );
}

/** Drop one image from every cached feed (quarantine, purge). */
export function removeImageFromFeeds(qc: QueryClient, id: string): void {
  removeImagesFromFeeds(qc, [id]);
}

/**
 * Drop several images from every cached feed in one pass: the batch-selection
 * counterpart to removeImageFromFeeds.
 */
export function removeImagesFromFeeds(
  qc: QueryClient,
  ids: readonly string[],
): void {
  if (!ids.length) return;
  const drop = new Set(ids);
  patchFeeds(qc, (pages) => pages.map((page) => page.filter((d) => !drop.has(d._id))));
}

/**
 * Refetch the feed, the grouped view and the tag aggregates after a mutation
 * (tag counts move with tag writes, quarantine and purges alike).
 */
export function invalidateFeeds(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: IMAGE_FEED_PREFIX });
  qc.invalidateQueries({ queryKey: IMAGE_GROUPS_PREFIX });
  qc.invalidateQueries({ queryKey: TAGS_KEY });
}
