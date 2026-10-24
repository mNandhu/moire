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
// From the domain modules, not "./queries": that re-exports lib/libraries.ts,
// which imports this module.
import { IMAGE_STATS_KEY, imageEmbeddingsQuery, imageLorasQuery, imageModelsQuery } from "./queries/images";
import { TAGS_KEY } from "./queries/tags";
import type { ImageDoc } from "./imageFilter";
import { IMAGE_FEED_PREFIX, IMAGE_GROUPS_PREFIX, imageDocKey, type FeedPage } from "./imageApi";

// The cache keys live with the fetchers (lib/imageApi.ts); re-exported for
// the readers that patch through here.
export { IMAGE_DOC_PREFIX, IMAGE_FEED_PREFIX, IMAGE_GROUPS_PREFIX, imageDocKey } from "./imageApi";

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

/** One write in flight for one field of one image. */
type FieldWrite = { seq: number; value: unknown };
/** A field's writes in flight, and the last value the server confirmed (or the
 * one cached before the first write; `NONE` where that place held no copy). */
type FieldWrites = {
  pending: FieldWrite[];
  base: { seq: number; tile: unknown; doc: unknown };
};
const NONE = Symbol("none");
const fieldWrites = new WeakMap<QueryClient, Map<string, FieldWrites>>();
let writeSeq = 0;

function writesOf(qc: QueryClient): Map<string, FieldWrites> {
  let m = fieldWrites.get(qc);
  if (!m) fieldWrites.set(qc, (m = new Map()));
  return m;
}

/** The image as the first cached feed or grouped view holding it has it. */
function cachedTile(qc: QueryClient, id: string): ImageDoc | undefined {
  for (const q of feedQueries(qc)) {
    const hit = (q.state.data as FeedData | undefined)?.pages.flatMap((p) => p.items).find((d) => d._id === id);
    if (hit) return hit;
  }
  for (const q of groupQueries(qc)) {
    const hit = (q.state.data as GroupsData | undefined)?.pages.flat().find((d) => d._id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Set fields on the tiles and on the doc; with `onlyWhile`, only a field that
 * still holds that value (so a refetch that landed meanwhile is kept). */
function setFields(
  qc: QueryClient,
  id: string,
  docId: string,
  tile: Partial<ImageDoc>,
  doc: Partial<ImageDoc>,
  onlyWhile?: Partial<ImageDoc>,
): void {
  const apply = (cur: ImageDoc, vals: Partial<ImageDoc>) => {
    const ks = (Object.keys(vals) as (keyof ImageDoc)[]).filter(
      (k) => cur[k] !== vals[k] && (!onlyWhile || cur[k] === onlyWhile[k]),
    );
    return ks.length ? { ...cur, ...Object.fromEntries(ks.map((k) => [k, vals[k]])) } : cur;
  };
  if (Object.keys(tile).length) patchImageInFeeds(qc, id, (d) => apply(d, tile));
  const q = qc.getQueryCache().find({ queryKey: imageDocKey(docId), exact: true });
  const cur = q?.state.data as ImageDoc | undefined;
  if (q && cur && Object.keys(doc).length) patchData(q, apply(cur, doc));
}

/**
 * Write fields of one image optimistically: shown at once everywhere it is
 * cached, `write` awaited, then patched again (a feed or doc fetch that
 * started before the write may have brought the old value back meanwhile).
 * On failure the patch is undone and the error rethrown. A doc fetch already
 * in flight is cancelled first, or it would land after the patch and undo it.
 * `docId` as in patchImageEverywhere.
 *
 * Writes to the same field of the same image may overlap (score 3, then 4,
 * before the first returns): only the newest one still standing decides what
 * shows. An older write settling late neither re-patches nor undoes; a failed
 * newest write falls back to the next newest in flight, else to the last value
 * the server confirmed.
 */
export async function writeImageFields(
  qc: QueryClient,
  id: string,
  fields: Partial<ImageDoc>,
  write: () => Promise<unknown>,
  docId: string = id,
): Promise<void> {
  await qc.cancelQueries({ queryKey: imageDocKey(docId), exact: true });
  const seq = ++writeSeq;
  const keys = Object.keys(fields) as (keyof ImageDoc)[];
  const writes = writesOf(qc);
  const tile0 = cachedTile(qc, id);
  const doc0 = qc.getQueryData<ImageDoc>(imageDocKey(docId));
  for (const k of keys) {
    const sk = `${id}\0${k}`;
    let w = writes.get(sk);
    if (!w) {
      w = { pending: [], base: { seq: 0, tile: tile0 ? tile0[k] : NONE, doc: doc0 ? doc0[k] : NONE } };
      writes.set(sk, w);
    }
    w.pending.push({ seq, value: fields[k] });
  }
  setFields(qc, id, docId, fields, fields);

  let failure: { e: unknown } | null = null;
  try {
    await write();
  } catch (e) {
    failure = { e };
  }

  const tile: Record<string, unknown> = {};
  const doc: Record<string, unknown> = {};
  for (const k of keys) {
    const sk = `${id}\0${k}`;
    const w = writes.get(sk)!;
    w.pending = w.pending.filter((p) => p.seq !== seq);
    if (!failure && seq > w.base.seq) w.base = { seq, tile: fields[k], doc: fields[k] };
    const top = w.pending.reduce<FieldWrite | null>((a, p) => (!a || p.seq > a.seq ? p : a), null);
    const winner = top && top.seq > w.base.seq ? { seq: top.seq, tile: top.value, doc: top.value } : w.base;
    if (!w.pending.length) writes.delete(sk);
    if (!failure ? winner.seq === seq : seq > winner.seq) {
      if (winner.tile !== NONE) tile[k] = winner.tile;
      if (winner.doc !== NONE) doc[k] = winner.doc;
    }
  }
  if (failure) {
    setFields(qc, id, docId, tile, doc, fields);
    throw failure.e;
  }
  setFields(qc, id, docId, tile, doc);
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
  const keep = (page: ImageDoc[]) =>
    page.some((d) => drop.has(d._id)) ? page.filter((d) => !drop.has(d._id)) : page;
  patchFeeds(qc, (pages) => pages.map(keep));
  // The grouped view holds plain arrays of representatives. A batch tile stands
  // for its other members too, so only a single-image tile goes; the refetch
  // that follows picks a batch's new representative and count.
  const keepGroup = (page: ImageDoc[]) =>
    page.some((d) => drop.has(d._id) && (d.group_count ?? 1) <= 1)
      ? page.filter((d) => !drop.has(d._id) || (d.group_count ?? 1) > 1)
      : page;
  for (const q of groupQueries(qc)) {
    const old = q.state.data as GroupsData | undefined;
    if (!old) continue;
    const pages = old.pages.map(keepGroup);
    if (pages.some((p, i) => p !== old.pages[i])) patchData(q, { ...old, pages });
  }
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
  // Facet counts leave quarantined images out, so quarantine moves them too.
  for (const f of [imageModelsQuery, imageLorasQuery, imageEmbeddingsQuery]) qc.invalidateQueries({ queryKey: f.queryKey });
}
