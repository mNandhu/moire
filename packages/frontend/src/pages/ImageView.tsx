import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Picker } from "../components/ui/Picker";
import { getBackgroundLocation } from "../lib/backgroundLocation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Sparkles,
  Copy,
  Ban,
  Download,
  PanelRight,
  Workflow,
} from "lucide-react";
import { resolveMediaUrl } from "../lib/media";
import { useToast } from "../components/Toasts";
import { ImageCharacters } from "../components/ImageCharacters";
import { parseFilters, serializeFilters, fetchImage } from "../lib/imageFilter";
import { useImageFeed } from "../hooks/useImageFeed";
import { useAiTagging } from "../hooks/useAiTagging";
import { fetchWorkflow, workflowClipboardText } from "../lib/gen";
import {
  applyTags,
  setScore as apiSetScore,
  setQuarantine as apiSetQuarantine,
  setRating as apiSetRating,
} from "../lib/imageMutations";
import { accentFromBlurhash } from "../lib/blurhash";
import { pickRating, ratingBadgeClass } from "../lib/rating";
import {
  partitionTags,
  tagFlow,
  toPromptText,
  type FlowTag,
  type TagKind,
} from "../lib/tags";
import { splitBoilerplate } from "../lib/boilerplate";
import { useBoilerplate } from "../lib/queries";
import { isFormField } from "../lib/dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { Button } from "../components/ui/Button";
import { MARKER_DIGIT } from "../components/ui/ScoreMark";
import { Input } from "../components/ui/Input";

/** The gallery filtered to one tag. */
const tagHref = (tagRaw: string) => `/?tags=${encodeURIComponent(tagRaw)}`;

// Round controls floating over the image stage (back, details, prev/next).
const OVERLAY_BTN =
  "p-2 rounded-full bg-black/45 border border-white/10 text-white/80 hover:text-white hover:bg-black/65 disabled:opacity-30 disabled:pointer-events-none transition-colors duration-150";
import {
  imageDocKey,
  invalidateFeeds,
  patchImageEverywhere,
  removeImageFromFeeds,
  syncFeedsFromDoc,
} from "../lib/feedCache";

// How long a fetched image doc stays fresh. Shared by the current-image query
// and the neighbour prefetch so stepping through the feed reuses prefetched
// docs rather than refetching them.
const IMAGE_DOC_STALE_MS = 30_000;

// Longest the view will hold the previous image while waiting on the next one
// to decode. Past this we show it regardless rather than appear stuck.
const MAX_HOLD_MS = 2000;

export default function ImageView() {
  // `routeId` is where the URL points; `id` is the image actually on screen.
  // They diverge only while a not-yet-decoded image is being waited on; see
  // the commit-on-decode effect below.
  const { id: routeId } = useParams<{ id: string }>();
  const [displayId, setDisplayId] = useState<string | undefined>(routeId);
  const id = displayId ?? routeId;
  const [pending, setPending] = useState(false);
  // Start of the current divergence between route and display, so the hold
  // ceiling is measured from the first keypress rather than restarted by each
  // one; otherwise a held arrow key defers it forever.
  const holdStartRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  // Set when opened over the gallery (see RootRoutes); absent on a direct
  // link or refresh, where this view is the only thing on the page.
  const backgroundLocation = getBackgroundLocation(location);
  const [searchParams] = useSearchParams();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [infoOpen, setInfoOpen] = useState(true);
  // Which image has actually painted. Tracked by id rather than as a boolean
  // so it resets with every navigation (a write-once flag would let one failed
  // load disable the glow for the rest of the session) and so a fresh mount,
  // where there is no previous frame to hold, still reads as loading.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  // Resolved media URLs keyed by image id (only non-passthrough modes populate
  // this). Kept as a map so an id change never renders the *previous* image's
  // URL for a frame; the endpoint below is always derivable synchronously.
  const [resolvedUrls, setResolvedUrls] = useState<Record<string, string>>({});
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  // Holds decoded neighbour bitmaps alive so the browser keeps them in its
  // decoded-image cache; without a live reference they are collectable and the
  // preload buys nothing but the HTTP hit.
  const preloadedRef = useRef<Map<string, HTMLImageElement>>(new Map());

  // Image filter carried in the URL, drives the shared Image feed so the
  // pages the gallery already fetched are reused here (no separate paging code).
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const filterQuery = useMemo(
    () => serializeFilters(filters).toString(),
    [filters],
  );
  const toImage = useCallback(
    (imgId: string) =>
      `/image/${encodeURIComponent(imgId)}${filterQuery ? `?${filterQuery}` : ""}`,
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
  // Closing the view: if it was opened over the gallery, go back to that exact
  // history entry (cheap, the gallery never unmounted) instead of pushing a
  // fresh navigation to it.
  const goBack = useCallback(() => {
    if (backgroundLocation) {
      navigate(-1);
    } else {
      navigate(`/${filterQuery ? `?${filterQuery}` : ""}`);
    }
  }, [backgroundLocation, navigate, filterQuery]);

  // Current image document (full doc with tags/rating); refetched after edits.
  const { data, refetch, dataUpdatedAt } = useQuery({
    queryKey: imageDocKey(id!),
    queryFn: ({ signal }) => fetchImage(id!, { signal }),
    enabled: !!id,
    // Matches the neighbour prefetch below, so arriving on a prefetched image
    // reuses the doc instead of refetching it.
    staleTime: IMAGE_DOC_STALE_MS,
  });
  const refreshImage = useCallback(() => {
    void refetch();
  }, [refetch]);
  // This document is the source of truth for the open image; every time it
  // changes (after any edit made here, or a server-side effect like AI
  // tagging), the gallery tiles behind the overlay take the same values, but
  // only where this copy is newer than the tile's (a doc served from cache
  // must not roll a fresher tile back).
  useEffect(() => {
    if (data) syncFeedsFromDoc(queryClient, data, dataUpdatedAt);
  }, [data, dataUpdatedAt, queryClient]);
  // Tag edits can move the image in or out of a filtered feed and change tag
  // counts, which a field copy can't express. Refetching the feed right away
  // would drop the open image from the list ImageView steps through (in the
  // untagged view, tagging it is the whole point), so the feeds refetch once,
  // when ImageView closes.
  const feedsDirty = useRef(false);
  const onTagsChanged = useCallback(() => {
    refreshImage();
    feedsDirty.current = true;
  }, [refreshImage]);
  useEffect(
    () => () => {
      if (feedsDirty.current) invalidateFeeds(queryClient);
    },
    [queryClient],
  );

  const score = data?.score ?? 0;
  const quarantined = !!data?.quarantined;

  const applyScore = useCallback(
    async (n: number) => {
      if (!id) return;
      const canonical = data?._id ?? id;
      // A doc fetch already in flight would land after the patch and undo it.
      await queryClient.cancelQueries({ queryKey: imageDocKey(id), exact: true });
      // Shown at once, here and on the gallery tile; undone if the write fails.
      const undo = patchImageEverywhere(queryClient, canonical, { score: n }, id);
      try {
        await apiSetScore(id, n);
        // Again on success: a feed fetch that started before the write may
        // have brought the old value back in the meantime.
        patchImageEverywhere(queryClient, canonical, { score: n }, id);
        refreshImage();
      } catch (e) {
        undo();
        push(`Failed to set score: ${String(e)}`, "error");
      }
    },
    [id, data?._id, push, refreshImage, queryClient],
  );

  const toggleQuarantine = useCallback(async () => {
    if (!id) return;
    const next = !quarantined;
    try {
      await apiSetQuarantine(id, next);
      push(next ? "Quarantined" : "Restored", "info");
      refreshImage();
      // Drop it from every cached feed so the gallery reflects the change
      // without a refresh.
      removeImageFromFeeds(queryClient, id);
      invalidateFeeds(queryClient);
    } catch (e) {
      push(`Failed to update quarantine: ${String(e)}`, "error");
    }
  }, [id, quarantined, push, refreshImage, queryClient]);

  const copyWorkflow = useCallback(async () => {
    if (!id) return;
    try {
      const wf = await fetchWorkflow(id);
      const text = workflowClipboardText(wf);
      if (!text) {
        push("No workflow data to copy", "info");
        return;
      }
      await navigator.clipboard.writeText(text);
      push("Workflow copied to clipboard", "success");
    } catch (e) {
      push(`Copy failed: ${String(e)}`, "error");
    }
  }, [id, push]);

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
    const ep = `/api/v1/images/${encodeURIComponent(id)}/file`;
    return resolvedUrls[id] ?? ep;
  }, [id, resolvedUrls]);

  // Blur-up placeholder shown under the original while it loads. Reuses the
  // exact thumb URL the gallery tile rendered (when the feed item is known)
  // so the browser serves it from cache instead of refetching; the thumb is
  // almost always already decoded from scrolling past it in the grid. Looked
  // up by `id` (the image on screen), not `index` (which tracks `routeId`);
  // those diverge while a navigation is held pending, and keying off the
  // route target would show the *next* image's thumb under the current one.
  const thumbUrl = useMemo(() => {
    if (!id) return null;
    const item = list.find((x) => x._id === id);
    return item?.thumb_url ?? `/api/v1/images/${encodeURIComponent(id)}/thumb`;
  }, [id, list]);
  const listItem = useMemo(() => list.find((x) => x._id === id), [id, list]);
  const [thumbFailed, setThumbFailed] = useState(false);
  useEffect(() => {
    setThumbFailed(false);
  }, [thumbUrl]);

  useEffect(() => {
    if (!id || resolvedUrls[id]) return;
    const ep = `/api/v1/images/${encodeURIComponent(id)}/file`;
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
    const ep = `/api/v1/images/${encodeURIComponent(routeId)}/file`;
    const img = new Image();
    void resolveMediaUrl(ep)
      .catch(() => ep)
      .then((u) => {
        img.src = u;
        return img.decode().then(() => u);
      })
      .then((u) => {
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
      // Never let a neighbour compete with the image actually on screen.
      img.fetchPriority = "low";
      preloadedRef.current.set(it._id, img);
      const ep = `/api/v1/images/${encodeURIComponent(it._id)}/file`;
      resolveMediaUrl(ep)
        .catch(() => ep)
        .then((u) => {
          img.src = u;
          // Decode off the main navigation path; without this the bitmap is
          // only decoded when it is first painted, which is the stall we see.
          return img.decode();
        })
        .catch(() => {});
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
  }, [
    index,
    list.length,
    feed.hasNextPage,
    feed.isFetchingNextPage,
    feed.fetchNextPage,
  ]);

  const goPrev = useCallback(() => {
    if (index > 0) navigateToImage(list[index - 1]._id);
  }, [index, list, navigateToImage]);

  const goNext = useCallback(async () => {
    if (index < 0) return;
    if (index < list.length - 1) {
      navigateToImage(list[index + 1]._id);
      return;
    }
    // At the end of the loaded pages: fetch the next one, then advance.
    if (feed.hasNextPage && !feed.isFetchingNextPage) {
      const res = await feed.fetchNextPage();
      const all = res.data?.pages.flatMap((p) => p.items) ?? [];
      const nextItem = all[index + 1];
      if (nextItem) navigateToImage(nextItem._id);
    }
  }, [
    index,
    list,
    navigateToImage,
    feed.hasNextPage,
    feed.isFetchingNextPage,
    feed.fetchNextPage,
  ]);

  const hasMore = feed.hasNextPage;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't trigger global shortcuts when typing in form fields
      if (isFormField(e.target)) {
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        goBack();
      }
      // Curation acts on the image on screen. While the view is held mid-swap
      // that is not the one the URL has moved to, so ignore these until the
      // stage and the route agree; better than scoring an image you have
      // already stepped past.
      if (pending) return;
      // Curation: 1-5 set score, 0 clears, X quarantines/restores.
      if (e.key >= "0" && e.key <= "5") {
        e.preventDefault();
        void applyScore(Number(e.key));
      }
      if (e.key === "x" || e.key === "X" || e.key === "Delete") {
        e.preventDefault();
        void toggleQuarantine();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    goPrev,
    goNext,
    goBack,
    applyScore,
    toggleQuarantine,
    pending,
  ]);

  // Touch/swipe navigation
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    }
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current || e.changedTouches.length !== 1) return;

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;

      // Minimum swipe distance (pixels)
      const minSwipeDistance = 50;
      // Maximum vertical movement to still count as horizontal swipe
      const maxVerticalDistance = 100;

      // Check if this is a horizontal swipe
      if (
        Math.abs(deltaX) >= minSwipeDistance &&
        Math.abs(deltaY) <= maxVerticalDistance
      ) {
        e.preventDefault();
        if (deltaX > 0) {
          // Swipe right -> go to previous image
          goPrev();
        } else {
          // Swipe left -> go to next image
          goNext();
        }
      }

      touchStartRef.current = null;
    },
    [goPrev, goNext],
  );

  const handleTouchMove = useCallback((_e: React.TouchEvent) => {
    // Optional: could add visual feedback here for swipe in progress
  }, []);

  const copyAllTags = useCallback(async () => {
    const all = data?.tags ?? [];
    if (!all.length) {
      push("No tags to copy", "info");
      return;
    }
    // Prompt-ready: stored names with parentheses escaped, so a paste into
    // ComfyUI reads `hu_tao_(genshin_impact)` as a tag, not as emphasis.
    const text = toPromptText(all);
    try {
      await navigator.clipboard.writeText(text);
      push("Tags copied to clipboard", "success");
    } catch (e) {
      push(`Copy failed: ${String(e)}`, "error");
    }
  }, [data?.tags, push]);

  useDocumentTitle(data?.path ? data.path.split(/[\\/]/).pop() : null);

  if (!id) return null;

  const fileName = data?.path ? data.path.split(/[\\/]/).pop() : "";
  const {
    ai: aiTags,
    manual: manualTagsRaw,
    prompt: promptTagsRaw,
  } = partitionTags(data?.tags);
  const rating = pickRating(data);
  const accent = accentFromBlurhash(data?.blurhash);
  // Has the image currently on screen painted?
  const imgLoaded = !!id && loadedId === id;
  // Show the busy hint whenever the stage is not showing a painted copy of the
  // image the URL points at: either holding the previous frame while the next
  // one decodes (`pending`), or a fresh mount with nothing painted yet.
  const busy = pending || !imgLoaded;

  return (
    <div
      // Fixed, not in normal flow: this now mounts *alongside* the gallery
      // (see main.tsx's RootRoutes) rather than replacing it, so it needs to
      // cover the sidebar and grid itself instead of relying on being the only
      // thing on the page.
      className="fixed inset-0 z-[100] overflow-hidden bg-canvas text-white flex"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
    >
      {/* Image stage */}
      <div className="flex-1 h-full flex items-center justify-center relative overflow-hidden">
        {/* Back icon (overlay) */}
        <button
          onClick={goBack}
          className={`absolute top-4 left-4 z-50 ${OVERLAY_BTN}`}
          aria-label="Back"
          title="Back"
        >
          <ArrowLeft />
        </button>
        {/* Reopen details panel (overlay when collapsed) */}
        {!infoOpen && (
          <button
            onClick={() => setInfoOpen(true)}
            className={`absolute top-4 right-4 z-50 ${OVERLAY_BTN}`}
            title="Show details"
            aria-label="Show details"
          >
            <PanelRight />
          </button>
        )}
        {/* The stage renders off `id` alone, never off the fetched doc: keeping
            this <img> element mounted across navigations is what makes the
            browser hold the previous frame on screen until the next one has
            decoded, instead of flashing an empty stage. */}
        <div className="relative flex items-center justify-center">
          {/* Ambient glow: a blurred accent panel matching the image box.
                The blur spreads the primary colour outward from every edge, so
                the whole image acts as the light source (not a centre point).
                Blooms in only once the image has loaded. */}
          {accent && (
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute inset-0 z-0 blur-[80px] transition-all duration-1000 ease-out ${
                imgLoaded ? "opacity-60 scale-110" : "opacity-0 scale-90"
              }`}
              style={{ background: accent }}
            />
          )}
          {/* Blur-up placeholder: the (already-cached) thumbnail, blurred and
              slightly scaled up to hide its soft edge. Sits in normal flow;
              it is what defines the box while the original is absolutely
              positioned on top of it. Sized off the *original*'s dimensions
              (from the fetched doc), not the thumbnail's own; the thumbnail
              is downscaled, so sizing off its intrinsic pixels would render
              the whole stage at thumbnail resolution on a large viewport,
              and a missing/failed thumbnail file (no intrinsic size at all)
              would otherwise collapse the box to 0×0 and hide the original
              underneath forever. Opacity, not unmount, on error, so the
              width/height-derived box size survives a failed load. */}
          {thumbUrl && (
            <img
              src={thumbUrl}
              alt=""
              aria-hidden="true"
              width={listItem?.width ?? data?.width}
              height={listItem?.height ?? data?.height}
              onError={() => setThumbFailed(true)}
              className={`max-w-full max-h-dvh w-auto h-auto object-contain blur-xl scale-105 transition-opacity duration-300 ${
                imgLoaded || thumbFailed ? "opacity-0" : "opacity-100"
              }`}
            />
          )}
          <img
            src={fileUrl ?? undefined}
            alt="image"
            onLoad={() => setLoadedId(id ?? null)}
            // Absolutely positioned over the blurred thumb, which owns the
            // box's size. Hidden (not just dimmed) until it has actually
            // painted, so the browser's line-by-line JPEG decode is never
            // visible; only the blurred thumb is, until the swap.
            // Gated on `pending` only once loaded: when stepping, the src
            // only changes once the image has already decoded, so fading it
            // in would hide a frame that is ready to paint. The dim marks a
            // frame that is *stale*, held while the next one loads.
            className={`absolute inset-0 z-10 w-full h-full object-contain transition-opacity duration-200 ${
              !imgLoaded ? "opacity-0" : pending ? "opacity-40" : "opacity-100"
            }`}
          />
          {/* Busy hint for the cases that can still make you wait: opening
                the view cold, or stepping past the preload window. The delayed
                transition means an instant swap never flashes a spinner. */}
          <div
            aria-hidden={!busy}
            className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-200 ${
              busy ? "opacity-100 delay-200" : "opacity-0 delay-0"
            }`}
          >
            <div className="h-8 w-8 rounded-full border-2 border-white/25 border-t-white/90 animate-spin" />
          </div>
        </div>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-2">
          <button
            disabled={index <= 0}
            onClick={goPrev}
            className={`pointer-events-auto ${OVERLAY_BTN}`}
            aria-label="Previous"
            title="Previous"
          >
            <ChevronLeft />
          </button>
          <button
            disabled={index < 0 || (index >= list.length - 1 && !hasMore)}
            onClick={goNext}
            className={`pointer-events-auto ${OVERLAY_BTN}`}
            aria-label="Next"
            title="Next"
          >
            <ChevronRight />
          </button>
        </div>
      </div>
      {/* Details sidebar: docked on desktop, slide-over drawer on mobile */}
      <aside
        role="region"
        aria-label="Image details"
        className={`fixed lg:static inset-y-0 right-0 z-40 h-dvh lg:h-full w-full sm:w-[380px] lg:w-[400px] lg:shrink-0 flex flex-col border-l border-line bg-surface shadow-xl shadow-black/30 lg:shadow-none transition-transform duration-300 ease-out lg:transition-none ${
          infoOpen ? "translate-x-0 lg:flex" : "translate-x-full lg:hidden"
        }`}
      >
        {data && (
          <>
            {/* Header: filename + quick actions */}
            <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-line shrink-0">
              <div className="min-w-0">
                <div
                  className="text-sm font-semibold truncate"
                  title={data.path}
                >
                  {fileName}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  {data.width}×{data.height} ·{" "}
                  {Math.round((data.size || 0) / 1024)} KB
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <a
                  href={
                    fileUrl ||
                    `/api/v1/images/${encodeURIComponent(data._id)}/file`
                  }
                  download={fileName || ""}
                  className="p-2 rounded-lg text-muted hover:text-white hover:bg-raised transition-colors"
                  title="Download original"
                  aria-label="Download original"
                >
                  <Download size={16} />
                </a>
                <button
                  onClick={() => setInfoOpen(false)}
                  className="p-2 rounded-lg text-muted hover:text-white hover:bg-raised transition-colors"
                  title="Collapse panel"
                  aria-label="Collapse panel"
                >
                  <PanelRight size={16} />
                </button>
              </div>
            </div>

            {/* Scrollable body */}
            {/* Flat sections split by rules: the sidebar is already a panel,
                so boxing each section again read as cards inside a card. */}
            <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-line">
              {/* Who is in it, first, like a photo app's people */}
              <ImageCharacters tags={data.tags} />

              {/* Curation (Moiré-specific) */}
              <Section title="Curation">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-neutral-300">Rating</span>
                  <RatingEditor
                    id={data._id}
                    docId={id!}
                    value={rating}
                    onDone={refreshImage}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-neutral-300">Score</span>
                  <ScorePicker value={score} onSet={applyScore} />
                </div>
                <Button
                  onClick={() => void toggleQuarantine()}
                  className={
                    quarantined
                      ? "w-full bg-amber-900/40 border-amber-800 text-amber-100 hover:bg-amber-900/60 hover:border-amber-700"
                      : "w-full"
                  }
                  title={quarantined ? "Restore (X)" : "Quarantine (X)"}
                >
                  <Ban size={14} /> {quarantined ? "Restore" : "Quarantine"}
                </Button>
              </Section>

              {/* Generation data */}
              <GenPanel
                gen={data.gen}
                width={data.width}
                height={data.height}
                onCopyAll={() => void copyWorkflow()}
              />

              {/* Tags: kept last; can be long, so it never pushes Curation
                  and Generation data below the fold. */}
              <Section
                title="Tags"
                right={
                  (aiTags.length || manualTagsRaw.length || promptTagsRaw.length) ? (
                    <button
                      type="button"
                      onClick={() => void copyAllTags()}
                      className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
                      title="Copy all tags as prompt text"
                    >
                      <Copy size={12} /> Copy all
                    </button>
                  ) : undefined
                }
              >
                {aiTags.length ||
                manualTagsRaw.length ||
                promptTagsRaw.length ? (
                  <TagFlow tags={tagFlow(data.tags, data.ai)} />
                ) : (
                  <div className="text-xs text-faint">No tags yet.</div>
                )}
                <TagEditor id={data._id} onChange={onTagsChanged} />
              </Section>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function TagEditor({ id, onChange }: { id: string; onChange: () => void }) {
  const [val, setVal] = useState("");
  const [adding, setAdding] = useState(false);
  const { start, cancel, submitting, cancelling, jobId, job, canCancel } =
    useAiTagging(onChange);

  const add = async () => {
    if (adding) return;
    const tags = val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!tags.length) return;
    setAdding(true);
    await applyTags(id, tags);
    setVal("");
    onChange();
    setAdding(false);
  };
  const ai = () => void start([id]);

  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-2">
        <Input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="Add manual tags (comma separated)"
          className="flex-1"
        />
        <Button onClick={add} disabled={adding}>
          Add
        </Button>
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={ai}
          disabled={submitting || Boolean(jobId)}
          title={
            jobId
              ? "AI tagging already in progress"
              : "Run AI tagging for this image"
          }
        >
          <Sparkles size={16} />
          {submitting ? "Starting…" : jobId ? "AI tagging…" : "Run AI tagging"}
        </Button>
        {canCancel && (
          <Button
            variant="dangerSoft"
            onClick={() => void cancel()}
            disabled={cancelling}
            title="Cancel the in-progress AI tagging job"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </div>

      {job && (
        <div className="text-xs text-muted">
          AI status: <span className="text-neutral-200">{job.status}</span>
          {job.total ? (
            <span>
              {" "}
              · {job.done + job.failed}/{job.total}
              {job.failed ? (
                <span className="text-red-300"> · {job.failed} failed</span>
              ) : null}
            </span>
          ) : null}
        </div>
      )}

      <Link
        to="/ai-tagging"
        className="inline-block text-xs text-faint hover:text-neutral-200"
        title="See AI tagging coverage, jobs, and their progress"
      >
        View AI tagging jobs
      </Link>
    </div>
  );
}

/**
 * The score editor: the same grease-pencil digits the gallery tiles show, so
 * marking a score looks like the mark it leaves. The chosen digit is drawn in
 * amber; clicking it again clears the score.
 */
function ScorePicker({
  value,
  onSet,
}: {
  value: number;
  onSet: (n: number) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5" role="radiogroup" aria-label="Score">
      {[1, 2, 3, 4, 5].map((n) => {
        const on = n === value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`Set score ${n}`}
            title={on ? "Clear score" : `Score ${n}`}
            onClick={() => onSet(on ? 0 : n)}
            className={
              on
                ? `${MARKER_DIGIT} text-[24px] w-7 h-8`
                : "font-marker text-[22px] leading-none w-7 h-8 text-white/30 hover:text-amber-200/80 transition-colors"
            }
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

// Card shell used by the details sidebar: a titled, bordered panel with an
// optional right-aligned control (e.g. the rating editor).
function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="px-4 py-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const KIND_TEXT: Record<TagKind, string> = {
  character: "text-brand-300 font-semibold",
  ai: "text-neutral-100",
  manual: "text-emerald-300",
  // Prompt tags are the bulk on most images; in a link-blue they turned the
  // whole run into what looked like a wall of hyperlinks.
  prompt: "text-muted",
};
const KIND_LABEL: Record<TagKind, string> = {
  character: "character",
  ai: "AI",
  manual: "yours",
  prompt: "prompt",
};

/**
 * An image's tags as one comma-separated run, like a prompt: dense, easy to
 * read top to bottom and to copy. Kind shows as text colour (legend below);
 * a less confident AI tag is fainter. Each tag links to the gallery filtered
 * by it. A tag's cover is picked on the Tags page.
 */
function TagFlow({ tags }: { tags: FlowTag[] }) {
  // Boilerplate (Settings) folds into one quiet toggle at the end, so the
  // tags that describe this image lead instead of "masterpiece, best quality".
  const isBoilerplate = useBoilerplate();
  const { kept, boilerplate } = useMemo(
    () => splitBoilerplate(tags, (t) => t.raw, isBoilerplate),
    [tags, isBoilerplate],
  );
  const [showBoilerplate, setShowBoilerplate] = useState(false);
  const shown = showBoilerplate ? [...kept, ...boilerplate] : kept;
  const kinds = (Object.keys(KIND_LABEL) as TagKind[]).filter((k) =>
    shown.some((t) => t.kind === k),
  );
  const firstBoilerplate = kept.length;
  return (
    <div className="space-y-2">
      <p className="text-[13px] leading-7">
        {shown.map((t, i) => (
          <React.Fragment key={t.raw}>
            <span className={i >= firstBoilerplate ? "opacity-50" : undefined}>
              <Link
                to={tagHref(t.raw)}
                className={`rounded px-0.5 -mx-0.5 hover:bg-raised hover:underline ${KIND_TEXT[t.kind]}`}
                style={
                  t.confidence != null
                    ? { opacity: 0.45 + 0.55 * t.confidence }
                    : undefined
                }
                title={
                  t.confidence != null
                    ? `Filter by ${t.label} · ${Math.round(t.confidence * 100)}% confidence`
                    : `Filter by ${t.label} (${KIND_LABEL[t.kind]})`
                }
              >
                {t.label}
              </Link>
            </span>
            {i < shown.length - 1 && <span className="text-line-strong">, </span>}
          </React.Fragment>
        ))}
        {boilerplate.length > 0 && (
          <>
            {shown.length > 0 && <span className="text-line-strong"> </span>}
            <button
              type="button"
              onClick={() => setShowBoilerplate((v) => !v)}
              aria-expanded={showBoilerplate}
              title={
                showBoilerplate
                  ? "Fold boilerplate tags away"
                  : `Show ${boilerplate.length} boilerplate ${boilerplate.length === 1 ? "tag" : "tags"} (set in Settings)`
              }
              className="inline-flex items-center h-5 px-1.5 rounded-full border border-line text-2xs text-faint hover:text-neutral-100 hover:border-line-strong align-middle"
            >
              {showBoilerplate ? "fold boilerplate" : `+${boilerplate.length} boilerplate`}
            </button>
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-faint">
        {kinds.map((k) => (
          <span key={k} className={`inline-flex items-center gap-1 ${KIND_TEXT[k]}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {KIND_LABEL[k]}
          </span>
        ))}
        {shown.some((t) => t.confidence != null) && <span>fainter = less confident</span>}
      </div>
    </div>
  );
}

// A small key/value pill for the "Other metadata" row.
function MetaChip({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <span className="px-2 py-1 rounded-md bg-raised border border-line text-xs inline-flex items-center gap-1.5 tabular-nums">
      <span className="text-faint">{label}</span>
      <span className="text-neutral-100">{value}</span>
    </span>
  );
}

function ResourceRow({
  name,
  badge,
  sub,
  to,
}: {
  name: string;
  badge: string;
  sub?: string;
  /** Gallery link showing every image that used this resource. */
  to?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        {to ? (
          <Link
            to={to}
            className="block text-sm text-neutral-100 truncate hover:underline"
            title={`Show all images using ${name}`}
          >
            {name}
          </Link>
        ) : (
          <div className="text-sm text-neutral-100 truncate" title={name}>
            {name}
          </div>
        )}
        {sub && <div className="text-xs text-faint">{sub}</div>}
      </div>
      <span className="shrink-0 text-2xs px-1.5 py-0.5 rounded-md bg-raised border border-line text-muted">
        {badge}
      </span>
    </div>
  );
}

function CopyButton({ text, label }: { text?: string | null; label: string }) {
  const { push } = useToast();
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          push(`${label} copied`, "success");
        } catch (e) {
          push(`Copy failed: ${String(e)}`, "error");
        }
      }}
      className="p-1.5 rounded-md text-muted hover:text-white hover:bg-raised transition-colors"
      title={`Copy ${label.toLowerCase()}`}
      aria-label={`Copy ${label.toLowerCase()}`}
    >
      <Copy size={14} />
    </button>
  );
}

// Prompt / negative-prompt text with a collapse-by-default "Show more".
function PromptBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <p
        className={`text-sm text-neutral-300 whitespace-pre-wrap break-words ${
          expanded ? "" : "line-clamp-3"
        }`}
      >
        {text}
      </p>
      {text.length > 140 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-brand-300 hover:text-brand-200"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// A prompt found by keywords (services/prompt_guess.py), not by following the
// workflow to its sampler.
function GuessedBadge() {
  return (
    <span
      className="text-2xs px-1.5 py-0.5 rounded-md border border-amber-400/30 text-amber-300"
      title="Picked by keyword match: the workflow doesn't show where its prompt goes. Pin it with Edit rule to be certain."
    >
      Guessed
    </span>
  );
}

function GenPanel({
  gen,
  width,
  height,
  onCopyAll,
}: {
  gen?: import("../lib/gen").GenMeta;
  width?: number;
  height?: number;
  onCopyAll: () => void;
}) {
  if (!gen || !gen.source) return null;
  return (
    <section className="px-4 py-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Generation data</h2>
        <div className="flex items-center gap-3">
          {gen.workflow_sig && (
            <Link
              to={`/rules?sig=${encodeURIComponent(gen.workflow_sig)}`}
              className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
              title="Edit this workflow's extraction rule"
            >
              <Workflow size={12} /> Edit rule
            </Link>
          )}
          <button
            type="button"
            onClick={onCopyAll}
            className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
            title="Copy all generation data"
          >
            <Copy size={12} /> Copy all
          </button>
        </div>
      </div>

      {(gen.model || !!gen.loras?.length || !!gen.embeddings?.length) && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted">
            Resources used
          </div>
          {gen.model && (
            <ResourceRow
              name={gen.model}
              badge="Checkpoint"
              to={`/?model=${encodeURIComponent(gen.model)}`}
            />
          )}
          {gen.loras?.map((l) => (
            <ResourceRow
              key={l.name}
              name={l.name}
              badge="LoRA"
              sub={l.strength != null ? `Strength ${l.strength}` : undefined}
              to={`/?lora=${encodeURIComponent(l.name)}`}
            />
          ))}
          {gen.embeddings?.map((e) => (
            <ResourceRow
              key={`${e.name}:${e.negative}`}
              name={e.name}
              badge="Embedding"
              sub={e.negative ? "In the negative prompt" : undefined}
              to={`/?embedding=${encodeURIComponent(e.name)}`}
            />
          ))}
        </div>
      )}

      {gen.prompt && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">Prompt</div>
              <span className="text-2xs uppercase px-1.5 py-0.5 rounded-md bg-raised border border-line text-muted">
                {gen.source}
              </span>
              {gen.guessed?.includes("prompt") && <GuessedBadge />}
            </div>
            <CopyButton text={gen.prompt} label="Prompt" />
          </div>
          <PromptBlock text={gen.prompt} />
        </div>
      )}

      {gen.negative && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">Negative prompt</div>
              {gen.guessed?.includes("negative") && <GuessedBadge />}
            </div>
            <CopyButton text={gen.negative} label="Negative prompt" />
          </div>
          <PromptBlock text={gen.negative} />
        </div>
      )}

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted">
          Other metadata
        </div>
        <div className="flex flex-wrap gap-1.5">
          <MetaChip label="CFG" value={gen.cfg} />
          <MetaChip label="Steps" value={gen.steps} />
          <MetaChip label="Sampler" value={gen.sampler} />
          <MetaChip label="Seed" value={gen.seed} />
          <MetaChip label="Width" value={width} />
          <MetaChip label="Height" value={height} />
        </div>
      </div>
    </section>
  );
}

function RatingEditor({
  id,
  docId,
  value,
  onDone,
}: {
  id: string;
  /** The id as spelled in the route: the key ImageView's doc is cached under. */
  docId: string;
  value: string;
  onDone: () => void;
}) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const v = (value || "-").trim() || "-";

  const setRating = async (next: string) => {
    if (next === v) return;
    setSaving(true);
    await queryClient.cancelQueries({ queryKey: imageDocKey(docId), exact: true });
    // Shown at once, here and on the gallery tile; undone if the write fails.
    const undo = patchImageEverywhere(queryClient, id, { rating: next }, docId);
    try {
      await apiSetRating(id, next);
      // Again on success, over any fetch that raced the write.
      patchImageEverywhere(queryClient, id, { rating: next }, docId);
      push("Rating updated", "success");
      onDone();
    } catch (e) {
      undo();
      push(`Failed to update rating: ${String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Picker
      aria-label="Change rating"
      value={v}
      disabled={saving}
      onChange={(next) => void setRating(next)}
      options={RATING_OPTIONS}
      className="inline-block group"
      trigger={() => (
        <span
          title="Change rating"
          className={`px-3 py-1 rounded-full text-xs border flex items-center gap-1.5 transition-all duration-200 ${ratingBadgeClass(
            v,
          )} ${saving ? "opacity-50" : "group-hover:scale-[1.02] group-hover:brightness-110"}`}
        >
          <span className="font-medium">{v === "-" ? "Unrated" : v}</span>
          <ChevronDown size={12} className="opacity-70" />
        </span>
      )}
    />
  );
}

const RATING_OPTIONS = [
  { value: "-", label: "Unrated" },
  { value: "general", label: "general" },
  { value: "sensitive", label: "sensitive" },
  { value: "questionable", label: "questionable" },
  { value: "explicit", label: "explicit" },
];
