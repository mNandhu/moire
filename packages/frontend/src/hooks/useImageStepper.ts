import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useImageFeed } from "./useImageFeed";
import { imageHref, serializeFilters, type Filters } from "../lib/imageFilter";
import { fetchImage } from "../lib/imageApi";
import { imageDocKey } from "../lib/feedCache";
import { imageFileUrl, loadImage, resolveMediaUrl } from "../lib/media";

// How long a fetched image doc stays fresh. Shared by the current-image query
// and the neighbour prefetch so stepping through the feed reuses prefetched
// docs rather than refetching them.
export const IMAGE_DOC_STALE_MS = 30_000;

// Longest the view will hold the previous image while waiting on the next one
// to decode. Past this we show it regardless rather than appear stuck.
const MAX_HOLD_MS = 2000;

/**
 * ImageView's walk through the shared Image feed. `routeId` is where the URL
 * points; the returned `id` is the image actually on screen. They diverge
 * only while a not-yet-decoded image is being waited on (`pending`); see the
 * commit-on-decode effect below. `index` tracks `routeId`, not `id`.
 * Owns the neighbour preload, paging the feed ahead, and stepping.
 */
export function useImageStepper(filters: Filters, routeId: string | undefined) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [displayId, setDisplayId] = useState<string | undefined>(routeId);
  const id = displayId ?? routeId;
  const [pending, setPending] = useState(false);
  // Start of the current divergence between route and display, so the hold
  // ceiling is measured from the first keypress rather than restarted by each
  // one; otherwise a held arrow key defers it forever.
  const holdStartRef = useRef<number | null>(null);
  // Resolved media URLs keyed by image id (only non-passthrough modes populate
  // this). Kept as a map so an id change never renders the *previous* image's
  // URL for a frame; the endpoint below is always derivable synchronously.
  const [resolvedUrls, setResolvedUrls] = useState<Record<string, string>>({});
  // Holds decoded neighbour bitmaps alive so the browser keeps them in its
  // decoded-image cache; without a live reference they are collectable and the
  // preload buys nothing but the HTTP hit.
  const preloadedRef = useRef<Map<string, HTMLImageElement>>(new Map());

  const filterQuery = useMemo(
    () => serializeFilters(filters).toString(),
    [filters],
  );
  const toImage = useCallback(
    (imgId: string) => imageHref(imgId, filterQuery),
    [filterQuery],
  );
  // Stepping to another image replaces the current history entry rather than
  // pushing a new one, for two reasons: it must carry `backgroundLocation`
  // forward or the gallery `<Routes>` (RootRoutes) stops matching the
  // background location and the gallery underneath unmounts mid-session; and
  // it keeps exactly one entry between the gallery and the viewer no matter
  // how many images were stepped through, so `goBack`'s single `navigate(-1)`
  // always exits in one Escape/Back press instead of walking back one image
  // at a time.
  const navigateToImage = useCallback(
    (imgId: string) =>
      navigate(toImage(imgId), { replace: true, state: location.state }),
    [navigate, toImage, location.state],
  );

  const feed = useImageFeed(filters);
  const list = feed.items;
  const index = useMemo(
    () => (routeId ? list.findIndex((x) => x._id === routeId) : -1),
    [routeId, list],
  );

  // The file URL is derived synchronously from the id, so the very first render
  // after an arrow-key navigation already points at the right image. The async
  // resolve only *overrides* it for modes that need a per-image resolve.
  const fileUrl = useMemo(() => {
    if (!id) return null;
    const ep = imageFileUrl(id);
    return resolvedUrls[id] ?? ep;
  }, [id, resolvedUrls]);

  useEffect(() => {
    if (!id || resolvedUrls[id]) return;
    const ep = imageFileUrl(id);
    let cancelled = false;
    resolveMediaUrl(ep)
      .then((u) => {
        if (cancelled || u === ep) return;
        setResolvedUrls((prev) => ({ ...prev, [id]: u }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, resolvedUrls]);

  // Commit-on-decode. Navigating only *requests* an image; the view keeps
  // showing the current one, image and details panel together, until the
  // requested image has decoded and can be painted in the same frame. Warm
  // (preloaded) images resolve immediately, so stepping stays instant; cold
  // ones hold the last good frame instead of tearing the stage away from the
  // panel. Holding the arrow key through a cold stretch coalesces naturally:
  // each new request supersedes the last, so only the final image is awaited.
  useEffect(() => {
    if (!routeId || routeId === displayId) {
      holdStartRef.current = null;
      setPending(false);
      return;
    }
    let cancelled = false;
    const commit = () => {
      if (cancelled) return;
      holdStartRef.current = null;
      setDisplayId(routeId);
      setPending(false);
    };
    // Nothing on screen yet (first mount / deep link): show it straight away.
    if (!displayId) {
      commit();
      return;
    }
    setPending(true);
    // Never hold the old frame hostage. The deadline is anchored to when the
    // route first ran ahead of the display, so holding a key cannot push it
    // back indefinitely.
    if (holdStartRef.current === null) holdStartRef.current = Date.now();
    const elapsed = Date.now() - holdStartRef.current;
    const timer = window.setTimeout(commit, Math.max(0, MAX_HOLD_MS - elapsed));
    const ep = imageFileUrl(routeId);
    void loadImage(routeId).then(({ src: u }) => {
      // Hand the resolved URL to the render path, so the <img> points at the
      // exact URL that was just decoded rather than re-resolving it.
      if (u && u !== ep && !cancelled) {
        setResolvedUrls((prev) => ({ ...prev, [routeId]: u }));
      }
      commit();
    }, commit);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [routeId, displayId]);

  // If the current id isn't in the loaded feed pages yet, keep paging until
  // it appears or the feed is exhausted. fetchNextPage reads the shared cache.
  useEffect(() => {
    if (!routeId || index !== -1) return;
    if (feed.hasNextPage && !feed.isFetchingNextPage) feed.fetchNextPage();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the query result is a new object every render; the listed fields are what the effect reads
  }, [
    routeId,
    index,
    feed.hasNextPage,
    feed.isFetchingNextPage,
    feed.fetchNextPage,
  ]);

  // Preload the neighbourhood around the current image so arrow-stepping never
  // waits on the network *or* the decoder. Forward-biased and three deep in
  // that direction, because a held arrow key outruns a +-1 window.
  useEffect(() => {
    if (!list.length || index < 0) return;
    const offsets = [1, -1, 2, 3, -2];
    const wanted = new Set<string>();

    for (const off of offsets) {
      const it = list[index + off];
      if (!it) continue;
      wanted.add(it._id);

      // The full doc: prefetching it is what removes the `data === undefined`
      // phase on arrival, so the sidebar never blanks either.
      void queryClient.prefetchQuery({
        queryKey: imageDocKey(it._id),
        queryFn: ({ signal }) => fetchImage(it._id, { signal }),
        // Without this the prefetch is stale on arrival and every step would
        // refetch the neighbours it already fetched one step ago.
        staleTime: IMAGE_DOC_STALE_MS,
      });

      if (preloadedRef.current.has(it._id)) continue;
      const img = new Image();
      preloadedRef.current.set(it._id, img);
      // Low priority: never let a neighbour compete with the image actually on
      // screen. loadImage decodes off the main navigation path; without that
      // the bitmap is only decoded when first painted, which is the stall.
      loadImage(it._id, { priority: "low", img }).catch(() => {});
    }

    // Keep the retained set small: holding every visited bitmap alive would
    // grow unbounded over a long browsing session.
    wanted.add(list[index]._id);
    for (const [key, img] of preloadedRef.current) {
      if (wanted.has(key)) continue;
      // Abort anything still downloading: an original the user has already
      // blown past should not keep competing for bandwidth.
      if (!img.complete) img.src = "";
      preloadedRef.current.delete(key);
    }
  }, [index, list, queryClient]);

  // Page ahead before hitting the tail, so `goNext` never has to await a fetch.
  useEffect(() => {
    if (index < 0 || !feed.hasNextPage || feed.isFetchingNextPage) return;
    if (index >= list.length - 3) void feed.fetchNextPage();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the query result is a new object every render; the listed fields are what the effect reads
  }, [
    index,
    list.length,
    feed.hasNextPage,
    feed.isFetchingNextPage,
    feed.fetchNextPage,
  ]);

  // The images arrow keys stepped to that the route has not reached yet. A
  // key pressed before the view re-renders steps from the last of them, not
  // from the place the route still shows (Right then Left must come back).
  // The route landing anywhere else (a batch strip click) drops them.
  const stepsRef = useRef<string[]>([]);
  useEffect(() => {
    const steps = stepsRef.current;
    const at = routeId ? steps.indexOf(routeId) : -1;
    stepsRef.current = at >= 0 ? steps.slice(at + 1) : [];
  }, [routeId]);
  const stepFrom = useCallback(() => {
    const last = stepsRef.current[stepsRef.current.length - 1];
    const at = last ? list.findIndex((x) => x._id === last) : -1;
    return at >= 0 ? at : index;
  }, [index, list]);
  const stepTo = useCallback(
    (imgId: string) => {
      stepsRef.current.push(imgId);
      navigateToImage(imgId);
    },
    [navigateToImage],
  );

  const goPrev = useCallback(() => {
    const at = stepFrom();
    if (at > 0) stepTo(list[at - 1]._id);
  }, [stepFrom, list, stepTo]);

  const goNext = useCallback(async () => {
    const at = stepFrom();
    if (at < 0) return;
    if (at < list.length - 1) {
      stepTo(list[at + 1]._id);
      return;
    }
    // At the end of the loaded pages: fetch the next one, then advance.
    if (feed.hasNextPage && !feed.isFetchingNextPage) {
      const res = await feed.fetchNextPage();
      const all = res.data?.pages.flatMap((p) => p.items) ?? [];
      const nextItem = all[at + 1];
      if (nextItem) stepTo(nextItem._id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the query result is a new object every render; the listed fields are what the effect reads
  }, [
    stepFrom,
    list,
    stepTo,
    feed.hasNextPage,
    feed.isFetchingNextPage,
    feed.fetchNextPage,
  ]);

  const hasMore = feed.hasNextPage;

  return { id, pending, index, list, fileUrl, goPrev, goNext, hasMore, filterQuery };
}
