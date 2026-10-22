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

import type { InfiniteData, Query, QueryClient } from "@tanstack/react-query";
import { IMAGE_STATS_KEY, TAGS_KEY } from "./queries";
import type { FeedPage, ImageDoc } from "./imageFilter";

/**
 * Every feed query key starts with this; TanStack matches by prefix, so it
 * reaches all cursor-paged feeds regardless of filter or page size.
 */
export const IMAGE_FEED_PREFIX = ["images"] as const;
const IMAGE_GROUPS_PREFIX = ["image-groups"] as const;

/** Query key of one Image's full document (ImageView's source of truth). */
export const imageDocKey = (id: string) => ["image", id] as const;

/**
 * Replace a query's data *without* touching its freshness. `setQueryData`
 * records a successful fetch: it clears `isInvalidated` and stamps
 * `dataUpdatedAt` with now, so a local patch would silently cancel a pending
 * invalidation and make an old snapshot look new. A patch is not a fetch;
 * writing `data` alone keeps both, and still notifies observers.
 */
function patchData<T>(query: Query, next: T): void {
  if (next !== query.state.data) query.setState({ data: next });
}

type FeedData = InfiniteData<FeedPage>;
type GroupsData = InfiniteData<ImageDoc[]>;

const feedQueries = (qc: QueryClient) =>
  qc.getQueryCache().findAll({ queryKey: IMAGE_FEED_PREFIX });
const groupQueries = (qc: QueryClient) =>
  qc.getQueryCache().findAll({ queryKey: IMAGE_GROUPS_PREFIX });

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
  for (const q of feedQueries(qc)) {
    const old = q.state.data as FeedData | undefined;
    if (!old) continue;
    const items = old.pages.map((p) => p.items);
    const patched = mut(items);
    if (patched.every((page, i) => page === items[i])) continue;
    patchData(q, {
      ...old,
      pages: old.pages.map((p, i) =>
        patched[i] === p.items ? p : { ...p, items: patched[i] ?? [] },
      ),
    });
  }
}

const hasImage = (page: ImageDoc[], id: string) => page.some((d) => d._id === id);

/**
 * Replace one image wherever it appears in a cached feed or grouped view.
 * Only queries that hold it are touched, and `when` can veto a query (see
 * syncFeedsFromDoc), so stepping through images costs nothing for the rest.
 */
export function patchImageInFeeds(
  qc: QueryClient,
  id: string,
  patch: (doc: ImageDoc) => ImageDoc,
  when: (q: Query) => boolean = () => true,
): void {
  const inPage = (page: ImageDoc[]) =>
    hasImage(page, id) ? page.map((d) => (d._id === id ? patch(d) : d)) : page;
  for (const q of feedQueries(qc)) {
    const old = q.state.data as FeedData | undefined;
    if (!old || !old.pages.some((p) => hasImage(p.items, id)) || !when(q)) continue;
    const pages = old.pages.map((p) => {
      const items = inPage(p.items);
      return items === p.items ? p : { ...p, items };
    });
    if (pages.some((p, i) => p !== old.pages[i])) patchData(q, { ...old, pages });
  }
  // The grouped view's pages are plain arrays of batch representatives.
  for (const q of groupQueries(qc)) {
    const old = q.state.data as GroupsData | undefined;
    if (!old || !old.pages.some((p) => hasImage(p, id)) || !when(q)) continue;
    const pages = old.pages.map(inPage);
    if (pages.some((p, i) => p !== old.pages[i])) patchData(q, { ...old, pages });
  }
}

// What a gallery tile draws from an image (see image_feed.FEED_COLUMNS); a
// change to any of these in ImageView must reach the tiles.
const TILE_FIELDS = ["score", "rating", "quarantined", "has_ai_tags"] as const;

/**
 * Copy the tile-visible fields of an image document into every cached feed
 * that holds the image, but only where the document is newer than the feed
 * (`docUpdatedAt`, the doc query's `dataUpdatedAt`). ImageView calls it when
 * its document changes, so edits made there (score, rating, tags, AI tagging
 * and whatever the server derives from them) are on the tile when you go
 * back; a doc served from cache that predates the feed never overwrites it.
 */
export function syncFeedsFromDoc(
  qc: QueryClient,
  doc: ImageDoc,
  docUpdatedAt: number,
): void {
  patchImageInFeeds(
    qc,
    doc._id,
    (tile) =>
      TILE_FIELDS.every((k) => tile[k] === doc[k])
        ? tile
        : { ...tile, ...Object.fromEntries(TILE_FIELDS.map((k) => [k, doc[k]])) },
    (q) => docUpdatedAt > q.state.dataUpdatedAt,
  );
}

/**
 * Optimistically set fields on one image everywhere it is cached: every feed
 * that holds it, the grouped view, and its document (under `docId`, the id as
 * spelled in the route, which may differ from the canonical `_id` in slash
 * direction). Freshness is left alone, so a stale document still refetches.
 *
 * Returns an undo for a failed write. It reverts only fields that still hold
 * this patch's value, so a later edit or refetch that landed meanwhile (a
 * second score that succeeded) is never rolled back.
 */
export function patchImageEverywhere(
  qc: QueryClient,
  id: string,
  fields: Partial<ImageDoc>,
  docId: string = id,
): () => void {
  const keys = Object.keys(fields) as (keyof ImageDoc)[];
  const docQuery = qc.getQueryCache().find({ queryKey: imageDocKey(docId), exact: true });
  const prevDoc = docQuery?.state.data as ImageDoc | undefined;
  let prevTile: ImageDoc | undefined;
  patchImageInFeeds(qc, id, (d) => {
    prevTile ??= d;
    return { ...d, ...fields };
  });
  if (docQuery && prevDoc) patchData(docQuery, { ...prevDoc, ...fields });

  const revert = (cur: ImageDoc, prev: ImageDoc) => {
    const back = keys.filter((k) => cur[k] === fields[k]);
    return back.length
      ? { ...cur, ...Object.fromEntries(back.map((k) => [k, prev[k]])) }
      : cur;
  };
  return () => {
    if (prevTile) {
      const prev = prevTile;
      patchImageInFeeds(qc, id, (d) => revert(d, prev));
    }
    const cur = docQuery?.state.data as ImageDoc | undefined;
    if (docQuery && cur && prevDoc) patchData(docQuery, revert(cur, prevDoc));
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

/** The image view's batch strip: a batch's members under the viewer's filters.
 * Its own key, not under the feeds': their cache patches assume a paged feed. */
export const BATCH_STRIP_KEY = ["batch-strip"] as const;

/**
 * Refetch the feed, the grouped view, the tag aggregates and the Overview
 * stats after a mutation (tag counts move with tag writes, quarantine and
 * purges alike; the quarantine count with the latter two).
 */
export function invalidateFeeds(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: IMAGE_FEED_PREFIX });
  qc.invalidateQueries({ queryKey: BATCH_STRIP_KEY });
  qc.invalidateQueries({ queryKey: IMAGE_GROUPS_PREFIX });
  qc.invalidateQueries({ queryKey: TAGS_KEY });
  qc.invalidateQueries({ queryKey: IMAGE_STATS_KEY });
}
