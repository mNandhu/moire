import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { PAGE_LIMIT, type Filters, type FeedItem } from "../lib/imageFilter";
import { IMAGE_FEED_PREFIX, IMAGE_GROUPS_PREFIX, fetchImagesPage, fetchGroupsPage, type FeedPage } from "../lib/imageApi";

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
  const query = useInfiniteQuery({
    queryKey: imageFeedKey(filters, limit),
    enabled,
    queryFn: ({ pageParam, signal }) =>
      fetchImagesPage(filters, { cursor: pageParam, limit, signal }),
    initialPageParam: null as string | null,
    // A short page means the end; otherwise page on the server's cursor.
    getNextPageParam: (lastPage: FeedPage) =>
      lastPage.items.length >= limit ? (lastPage.next ?? undefined) : undefined,
  });

  const items = useMemo<FeedItem[]>(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );

  return { ...query, items };
}

/**
 * The grouped (batch-collapsed) view of the feed. Offset-paged; each item is a
 * batch representative carrying `group_count`. Same filter shape as the feed.
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
      fetchGroupsPage(filters, { offset: pageParam, limit, signal }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: FeedItem[], allPages) =>
      lastPage.length >= limit ? allPages.length * limit : undefined,
  });

  const items = useMemo<FeedItem[]>(
    () => query.data?.pages.flat() ?? [],
    [query.data],
  );

  return { ...query, items };
}
