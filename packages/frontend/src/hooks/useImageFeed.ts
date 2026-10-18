import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  fetchImagesPage,
  fetchGroupsPage,
  nextCursorOf,
  PAGE_LIMIT,
  type Filters,
  type ImageDoc,
} from "../lib/imageFilter";

/**
 * Query key for the Image feed. Keyed by the Image filter so the gallery and
 * ImageView share one cache when they hold the same filter; paging in one is
 * visible to the other. See CONTEXT.md › Frontend › Image feed.
 */
export function imageFeedKey(filters: Filters, limit: number) {
  return ["images", limit, filters] as const;
}

/**
 * The Image feed: a cursor-paged stream of Images matching `filters`.
 * Wraps TanStack `useInfiniteQuery`; exposes the flattened `items` alongside
 * the usual query controls (`fetchNextPage`, `hasNextPage`, …).
 */
export function useImageFeed(filters: Filters, limit: number = PAGE_LIMIT) {
  const query = useInfiniteQuery({
    queryKey: imageFeedKey(filters, limit),
    queryFn: ({ pageParam, signal }) =>
      fetchImagesPage(filters, { cursor: pageParam, limit, signal }),
    initialPageParam: null as string | null,
    // A short page means the end; otherwise page on the last item's id.
    getNextPageParam: (lastPage: ImageDoc[]) =>
      lastPage.length >= limit ? nextCursorOf(lastPage, filters.sort) : undefined,
  });

  const items = useMemo<ImageDoc[]>(
    () => query.data?.pages.flat() ?? [],
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
    queryKey: ["image-groups", limit, filters] as const,
    enabled,
    queryFn: ({ pageParam, signal }) =>
      fetchGroupsPage(filters, { offset: pageParam, limit, signal }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: ImageDoc[], allPages) =>
      lastPage.length >= limit ? allPages.length * limit : undefined,
  });

  const items = useMemo<ImageDoc[]>(
    () => query.data?.pages.flat() ?? [],
    [query.data],
  );

  return { ...query, items };
}
