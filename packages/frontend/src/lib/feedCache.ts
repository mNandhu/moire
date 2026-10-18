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
import { IMAGE_STATS_KEY, TAGS_KEY } from "./queries";
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

/** Query key of one Image's full document (ImageView's source of truth). */
export const imageDocKey = (id: string) => ["image", id] as const;

/**
 * Replace one image wherever it appears in a cached feed or grouped view.
 * Pages without it keep their identity, so unrelated views don't re-render.
 */
export function patchImageInFeeds(
  qc: QueryClient,
  id: string,
  patch: (doc: ImageDoc) => ImageDoc,
): void {
  const inPage = (page: ImageDoc[]) =>
    page.some((d) => d._id === id)
      ? page.map((d) => (d._id === id ? patch(d) : d))
      : page;
  patchFeeds(qc, (pages) => pages.map(inPage));
  // The grouped view's pages are plain arrays of batch representatives.
  qc.setQueriesData<InfiniteData<ImageDoc[]>>(
    { queryKey: IMAGE_GROUPS_PREFIX },
    (old) => (old ? { ...old, pages: old.pages.map(inPage) } : old),
  );
}

// What a gallery tile draws from an image (see image_feed.FEED_COLUMNS); a
// change to any of these in ImageView must reach the tiles.
const TILE_FIELDS = ["score", "rating", "quarantined", "has_ai_tags"] as const;

/**
 * Copy the tile-visible fields of a fresh image document into every cached
 * feed. ImageView calls it whenever its document changes, so any edit made
 * there (score, rating, tags, AI tagging, and whatever the server derives
 * from them) is already on the tile when you go back, no reload needed.
 */
export function syncFeedsFromDoc(qc: QueryClient, doc: ImageDoc): void {
  patchImageInFeeds(qc, doc._id, (tile) =>
    TILE_FIELDS.every((k) => tile[k] === doc[k])
      ? tile
      : { ...tile, ...Object.fromEntries(TILE_FIELDS.map((k) => [k, doc[k]])) },
  );
}

/**
 * Optimistically set fields on one image everywhere it is cached: every feed,
 * the grouped view and its own document. Returns an undo for a failed write.
 */
export function patchImageEverywhere(
  qc: QueryClient,
  id: string,
  fields: Partial<ImageDoc>,
): () => void {
  const prevDoc = qc.getQueryData<ImageDoc>(imageDocKey(id));
  const prevTile: Partial<ImageDoc> = {};
  let captured = false;
  patchImageInFeeds(qc, id, (d) => {
    if (!captured) {
      for (const k of Object.keys(fields) as (keyof ImageDoc)[]) {
        (prevTile as Record<string, unknown>)[k] = d[k];
      }
      captured = true;
    }
    return { ...d, ...fields };
  });
  if (prevDoc) qc.setQueryData<ImageDoc>(imageDocKey(id), { ...prevDoc, ...fields });
  return () => {
    if (captured) patchImageInFeeds(qc, id, (d) => ({ ...d, ...prevTile }));
    if (prevDoc) qc.setQueryData(imageDocKey(id), prevDoc);
  };
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
 * Refetch the feed, the grouped view, the tag aggregates and the Overview
 * stats after a mutation (tag counts move with tag writes, quarantine and
 * purges alike; the quarantine count with the latter two).
 */
export function invalidateFeeds(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: IMAGE_FEED_PREFIX });
  qc.invalidateQueries({ queryKey: IMAGE_GROUPS_PREFIX });
  qc.invalidateQueries({ queryKey: TAGS_KEY });
  qc.invalidateQueries({ queryKey: IMAGE_STATS_KEY });
}
