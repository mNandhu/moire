import { useMemo } from "react";
import { infiniteQueryOptions, useInfiniteQuery, type QueryClient } from "@tanstack/react-query";
import { PAGE_LIMIT, isGroupedView, type Filters, type FeedItem } from "@/features/images/lib/imageFilter";
import { filtersFrom } from "@/features/images/hooks/useFilters";
import { IMAGE_FEED_PREFIX, IMAGE_GROUPS_PREFIX, fetchImagesPage, fetchGroupsPage, type FeedPage } from "@/features/images/lib/imageApi";

/**
 * Query key for the Image feed. Keyed by the Image filter so the gallery and
 * ImageView share one cache when they hold the same filter; paging in one is
 * visible to the other. See CONTEXT.md › Frontend › Image feed.
 *
 * `group` is left out: /images ignores it, so the flat cache is one entry on
 * either side of the Group toggle.
 */
export function imageFeedKey(filters: Filters, limit: number) {
  return [...IMAGE_FEED_PREFIX, limit, { ...filters, group: false }] as const;
}

function imageFeedOptions(filters: Filters, limit: number) {
  return infiniteQueryOptions({
    queryKey: imageFeedKey(filters, limit),
    queryFn: ({ pageParam, signal }) =>
      fetchImagesPage(filters, { cursor: pageParam, limit, signal }),
    initialPageParam: null as string | null,
    // The server sends no cursor after its last page. Not the page's length:
    // a removal patched into a cached page shortens it without ending the list.
    getNextPageParam: (lastPage: FeedPage) => lastPage.next ?? undefined,
  });
}

/**
 * Starts the gallery's first feed page before React renders, when the app
 * opens on the gallery: otherwise it waits for the first render and the
 * startup requests queued ahead of it. The gallery's own query picks up
 * this one in flight (same key and options).
 */
export function prefetchGalleryFeed(qc: QueryClient, url: Location = window.location) {
  if (url.pathname !== "/") return;
  const filters = filtersFrom(new URLSearchParams(url.search));
  if (isGroupedView(filters)) return;
  void qc.prefetchInfiniteQuery(imageFeedOptions(filters, PAGE_LIMIT));
}

/**
 * The Image feed: a cursor-paged stream of Images matching `filters`.
 * Wraps TanStack `useInfiniteQuery`; exposes the flattened `items` alongside
 * the usual query controls (`fetchNextPage`, `hasNextPage`, …). `enabled`
 * false keeps it idle (the gallery's grouped view shows groups instead).
 */
export function useImageFeed(
  filters: Filters,
  limit: number = PAGE_LIMIT,
  enabled: boolean = true,
) {
  const query = useInfiniteQuery({ ...imageFeedOptions(filters, limit), enabled });

  const items = useMemo<FeedItem[]>(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );

  return { ...query, items };
}

/**
 * The grouped (batch-collapsed) view of the feed. Cursor-paged like the feed;
 * each item is a batch representative carrying `group_count`. Same filter
 * shape as the feed.
 */
export function useImageGroups(
  filters: Filters,
  enabled: boolean,
  limit: number = PAGE_LIMIT,
) {
  const query = useInfiniteQuery({
    queryKey: [...IMAGE_GROUPS_PREFIX, limit, filters] as const,
    enabled,
    queryFn: ({ pageParam, signal }) =>
      fetchGroupsPage(filters, { cursor: pageParam, limit, signal }),
    initialPageParam: null as string | null,
    // The server sends no cursor after its last page. Not the page's length:
    // a removal patched into a cached page shortens it without ending the list.
    getNextPageParam: (lastPage: FeedPage) => lastPage.next ?? undefined,
  });

  const items = useMemo<FeedItem[]>(
    // A batch whose head stopped matching between page fetches (tagged
    // under an Untagged filter) heads a later page too: show it once.
    () => {
      const seen = new Set<string>();
      return (query.data?.pages.flatMap((p) => p.items) ?? []).filter((it) => {
        const key = it.group_id ?? it._id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    [query.data],
  );

  return { ...query, items };
}
