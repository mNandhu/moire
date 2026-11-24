// The Image feed's API client: one page of the feed or the grouped view, one
// Image, every id a filter matches. The filter itself (and its URL form) is
// features/images/lib/imageFilter.ts.

import { api, apiJson, apiRaw } from "@/lib/api";
import { PAGE_LIMIT, serializeFilters, type Filters, type FeedItem, type ImageDetail } from "./imageFilter";

/**
 * Every feed query key starts with this; TanStack matches by prefix, so it
 * reaches all cursor-paged feeds regardless of filter or page size.
 */
export const IMAGE_FEED_PREFIX = ["images"] as const;
/** Every grouped (batch-collapsed) view's key starts with this. */
export const IMAGE_GROUPS_PREFIX = ["image-groups"] as const;
/** Every flat, unpaged list of feed rows (Discover's random picks) starts
 * with this, so edits made in the image view reach those tiles too. */
export const IMAGE_PICKS_PREFIX = ["image-picks"] as const;
/** Every single-Image document's key starts with this. */
export const IMAGE_DOC_PREFIX = ["image"] as const;

/** Query key of one Image's full document (ImageView's source of truth). */
export const imageDocKey = (id: string) => [...IMAGE_DOC_PREFIX, id] as const;

/**
 * Build the `/api/v1/images` query string for one page of the Image feed:
 * the filter params plus pagination (limit, optional cursor).
 */
export function buildImagesQuery(
  filters: Filters,
  opts: { cursor?: string | null; limit?: number } = {},
): string {
  const sp = serializeFilters(filters);
  sp.set("limit", String(opts.limit ?? PAGE_LIMIT));
  if (opts.cursor) sp.set("cursor", opts.cursor);
  return sp.toString();
}

/**
 * One page of the Image feed and the cursor for the page after it. The server
 * builds the cursor (`X-Next-Cursor`) from the values it sorted on; building
 * it here from cached items went wrong as soon as a local edit (a new score
 * under "top") changed the last item's sort key.
 */
export type FeedPage = { items: FeedItem[]; next: string | null };

type PageOpts = { cursor?: string | null; limit?: number; signal?: AbortSignal };

async function fetchPage(path: string, filters: Filters, opts: PageOpts): Promise<FeedPage> {
  const qs = buildImagesQuery(filters, opts);
  const r = await apiRaw(`${path}?${qs}`, { signal: opts.signal });
  return {
    items: (await r.json()) as FeedItem[],
    next: r.headers.get("X-Next-Cursor"),
  };
}

/** Fetch one page of the Image feed. Throws on non-OK response. */
export function fetchImagesPage(filters: Filters, opts: PageOpts = {}): Promise<FeedPage> {
  return fetchPage("/api/v1/images", filters, opts);
}

/** Fetch one page of the grouped (batch-collapsed) view: batch
 * representatives, cursor-paged like the feed (the server's cursor is the
 * last representative's). */
export function fetchGroupsPage(filters: Filters, opts: PageOpts = {}): Promise<FeedPage> {
  return fetchPage("/api/v1/images/groups", filters, opts);
}

/** Fetch a single Image document by id. Throws on non-OK response. */
export function fetchImage(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ImageDetail> {
  return api<ImageDetail>(`/api/v1/images/${encodeURIComponent(id)}`, { signal: opts.signal });
}

/** Every image id the filter matches, not just the loaded pages (capped
 * server-side: `truncated` says so). */
export function fetchImageIds(filters: Filters): Promise<{ ids: string[]; truncated: boolean }> {
  return api(`/api/v1/images/ids?${serializeFilters(filters)}`);
}

/** Random images the filter matches, a new pick each call ("I'm feeling
 * lucky"). Any order the filter sets is ignored. */
export function fetchRandomImages(filters: Filters, limit = 50): Promise<FeedItem[]> {
  const sp = serializeFilters(filters);
  sp.delete("sort");
  sp.set("limit", String(limit));
  return api<FeedItem[]>(`/api/v1/images/random?${sp}`);
}

/** Note that the image view showed the image (the "not opened lately"
 * filter, Discover's Forgotten favorites, reads it). */
export async function markImageViewed(id: string): Promise<void> {
  await apiRaw(`/api/v1/images/${encodeURIComponent(id)}/viewed`, { method: "POST" });
}

/** Re-roll the shuffled order (every image's shuffle key). */
export function reshuffleImages(): Promise<{ images: number }> {
  return apiJson(`/api/v1/images/reshuffle`, "POST");
}
