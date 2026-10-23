// The Image feed's API client: one page of the feed or the grouped view, one
// Image, every id a filter matches. The filter itself (and its URL form) is
// lib/imageFilter.ts.

import { api, apiRaw } from "./api";
import { PAGE_LIMIT, serializeFilters, type Filters, type ImageDoc } from "./imageFilter";

/**
 * Every feed query key starts with this; TanStack matches by prefix, so it
 * reaches all cursor-paged feeds regardless of filter or page size.
 */
export const IMAGE_FEED_PREFIX = ["images"] as const;
/** Every grouped (batch-collapsed) view's key starts with this. */
export const IMAGE_GROUPS_PREFIX = ["image-groups"] as const;
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
export type FeedPage = { items: ImageDoc[]; next: string | null };

/** Fetch one page of the Image feed. Throws on non-OK response. */
export async function fetchImagesPage(
  filters: Filters,
  opts: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<FeedPage> {
  const qs = buildImagesQuery(filters, opts);
  const r = await apiRaw(`/api/v1/images?${qs}`, { signal: opts.signal });
  return {
    items: (await r.json()) as ImageDoc[],
    next: r.headers.get("X-Next-Cursor"),
  };
}

/** Fetch one page of the grouped (batch-collapsed) view. Offset-paged because
 * grouping is a server-side aggregation, not cursor-pageable. */
export function fetchGroupsPage(
  filters: Filters,
  opts: { offset?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<ImageDoc[]> {
  const sp = serializeFilters(filters);
  sp.set("limit", String(opts.limit ?? PAGE_LIMIT));
  sp.set("offset", String(opts.offset ?? 0));
  return api<ImageDoc[]>(`/api/v1/images/groups?${sp.toString()}`, { signal: opts.signal });
}

/** Fetch a single Image document by id. Throws on non-OK response. */
export function fetchImage(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ImageDoc> {
  return api<ImageDoc>(`/api/v1/images/${encodeURIComponent(id)}`, { signal: opts.signal });
}

/** Every image id the filter matches, not just the loaded pages (capped
 * server-side: `truncated` says so). */
export function fetchImageIds(filters: Filters): Promise<{ ids: string[]; truncated: boolean }> {
  return api(`/api/v1/images/ids?${serializeFilters(filters)}`);
}
