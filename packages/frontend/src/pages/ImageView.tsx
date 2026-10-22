import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Picker } from "../components/ui/Picker";
import { ResolvePromptDialog } from "../components/ResolvePromptDialog";
import { getBackgroundLocation } from "../lib/backgroundLocation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Sparkles,
  RotateCcw,
  Loader2,
  Copy,
  Ban,
  Download,
  FolderOpen,
  PanelRight,
  Plus,
  Workflow,
  X,
} from "lucide-react";
import { resolveMediaUrl } from "../lib/media";
import { useToast } from "../components/Toasts";
import { ImageCharacters } from "../components/ImageCharacters";
import { parseFilters, serializeFilters, fetchImage } from "../lib/imageFilter";
import { useImageFeed } from "../hooks/useImageFeed";
import { useAiTagging } from "../hooks/useAiTagging";
import { useBackgroundTasks } from "../hooks/useBackgroundTasks";
import { aiJobLabel } from "../lib/ai";
import { describeTask } from "../lib/backgroundTasks";
import { ProgressBar } from "../components/ui/ProgressBar";
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
  adherenceGroups,
  tagFlow,
  tagName,
  toPromptText,
  type FlowTag,
  type TagGroup,
  type TagKind,
} from "../lib/tags";
import { characterHref, tagHref } from "../lib/character";
import { splitBoilerplate } from "../lib/boilerplate";
import { libraryPageHref, useBoilerplate, useLibraries, useTagFacets } from "../lib/queries";
import { FACET_LABEL, FACET_TINT, TAG_TINT_CLASS, tagMarkStyle, type Facet } from "../lib/tagColour";
import { useTagMarks } from "../hooks/useTagMarks";
import { isFormField } from "../lib/dom";
import { fitLines } from "../lib/fitLines";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { MARKER_DIGIT } from "../components/ui/ScoreMark";
import { Input } from "../components/ui/Input";
import { useConfirm } from "../components/ConfirmDialog";
import { Tooltip } from "../components/ui/Tooltip";
import { useRemix, type RemixInfo } from "../lib/generate";
import { RemixButton, WorkflowLine } from "../components/generate/Remix";

/** A tag's own page: the character page for a character, else the tag page. */
const tagPageHref = (t: FlowTag) =>
  (t.kind === "character" ? characterHref : tagHref)(tagName(t.raw));

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
  // Docked beside the image from lg up; below that the panel is a drawer over
  // the stage, so a phone opens on the image, not on a wall of metadata.
  const [infoOpen, setInfoOpen] = useState(
    () => window.matchMedia?.("(min-width: 1024px)")?.matches ?? true,
  );
  // The details panel's scroller and its content, for PromptBlock to fit the
  // prompt into the room left over (see PanelFit).
  const [panelScroller, setPanelScroller] = useState<HTMLDivElement | null>(null);
  const [panelContent, setPanelContent] = useState<HTMLDivElement | null>(null);
  const panelFit = useMemo(
    () => (panelScroller && panelContent ? { scroller: panelScroller, content: panelContent } : null),
    [panelScroller, panelContent],
  );
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
    // A deep link's image isn't in the feed: its doc carries the URL.
    return item?.thumb_url ?? data?.thumb_url ?? null;
  }, [id, list, data]);
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

  const copyPath = useCallback(async () => {
    if (!data?.path) return;
    try {
      await navigator.clipboard.writeText(data.path);
      push("Path copied to clipboard", "success");
    } catch (e) {
      push(`Copy failed: ${String(e)}`, "error");
    }
  }, [data?.path, push]);

  useDocumentTitle(data?.path ? data.path.split(/[\\/]/).pop() : null);
  const { data: libraries } = useLibraries({ poll: false });
  const library = libraries?.find((l) => l._id === data?.library_id);

  if (!id) return null;

  const fileName = data?.path ? data.path.split(/[\\/]/).pop() : "";
  const rating = pickRating(data);
  const flowTags = data ? tagFlow(data.tags, data.ai) : [];
  const accent = accentFromBlurhash(data?.blurhash);
  // Has the image currently on screen painted?
  const imgLoaded = !!id && loadedId === id;
  // Show the busy hint whenever the stage is not showing a painted copy of the
  // image the URL points at: either holding the previous frame while the next
  // one decodes (`pending`), or a fresh mount with nothing painted yet.
  const busy = pending || !imgLoaded;
  const stageW = listItem?.width ?? data?.width;
  const stageH = listItem?.height ?? data?.height;

  return (
    <div
      // Fixed, not in normal flow: this now mounts *alongside* the gallery
      // (see main.tsx's RootRoutes) rather than replacing it, so it needs to
      // cover the sidebar and grid itself instead of relying on being the only
      // thing on the page.
      className="fixed inset-0 z-[100] overflow-hidden bg-canvas text-white flex"
    >
      {/* Image stage. Swipes count only here: one that starts in the details
          drawer is a scroll, not a step to the next image. */}
      <div
        className="flex-1 h-full flex items-center justify-center relative overflow-hidden [container-type:size]"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
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
        <div
          className="relative flex items-center justify-center"
          // Grows to the largest box of the image's shape the stage holds (up
          // to 2x its pixels, so a small image doesn't turn to mush), instead
          // of stopping at its natural size. Unknown size: natural, as before.
          style={
            stageW && stageH
              ? { aspectRatio: `${stageW} / ${stageH}`, width: `min(100cqw, 100cqh * ${stageW / stageH}, ${stageW * 2}px)` }
              : undefined
          }
        >
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
          {/* Dithers the glow's banding; fades out past where it reaches. */}
          {accent && (
            <div
              aria-hidden="true"
              className={`grain pointer-events-none absolute -inset-[40%] z-0 transition-opacity duration-1000 ${
                imgLoaded ? "opacity-[0.02]" : "opacity-0"
              }`}
              style={{ maskImage: "radial-gradient(closest-side, black 70%, transparent)" }}
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
              className={`${stageW && stageH ? "w-full h-full" : "max-w-full max-h-dvh w-auto h-auto"} object-contain blur-xl scale-105 transition-opacity duration-300 ${
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
        className={`fixed lg:static inset-y-0 right-0 z-[60] h-dvh lg:h-full w-full sm:w-[380px] lg:w-[400px] lg:shrink-0 flex flex-col border-l border-line bg-surface shadow-xl shadow-black/30 lg:shadow-none transition-transform duration-300 ease-out lg:transition-none ${
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
                {library && (
                  <Link
                    to={libraryPageHref(library._id)}
                    title={`${library.path}\nShow in Libraries`}
                    className="mt-0.5 flex items-center gap-1 min-w-0 text-xs text-muted hover:text-white"
                  >
                    <FolderOpen size={12} className="shrink-0" />
                    <span className="truncate">{library.name || library.path}</span>
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => void copyPath()}
                  title="Copy path"
                  className="group mt-1 flex items-start gap-1 text-left text-xs text-faint hover:text-neutral-200"
                >
                  <span className="break-all">{data.path}</span>
                  <Copy size={11} className="mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 touch:opacity-100" />
                </button>
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
            <div ref={setPanelScroller} className="flex-1 min-h-0 overflow-y-auto">
              <PanelFit.Provider value={panelFit}>
                <div ref={setPanelContent}>
                  <div className="divide-y divide-line border-b border-line">
                    {/* Who is in it, first, like a photo app's people */}
                    <ImageCharacters imageId={data._id} tags={data.tags} quarantined={!!data.quarantined} />

                    {/* Curation in one row: rating, score, quarantine. Its
                        controls say what they are, so the row needs no labels. */}
                    <div className="flex items-center justify-between gap-2 px-4 py-2.5">
                      <RatingEditor
                        id={data._id}
                        docId={id!}
                        value={rating}
                        onDone={refreshImage}
                      />
                      <div className="flex items-center gap-1">
                        <ScorePicker value={score} onSet={applyScore} />
                        <button
                          type="button"
                          onClick={() => void toggleQuarantine()}
                          aria-pressed={quarantined}
                          title={quarantined ? "Restore (X)" : "Quarantine (X)"}
                          aria-label={quarantined ? "Restore" : "Quarantine"}
                          className={`ml-1 p-2 rounded-lg transition-colors ${
                            quarantined
                              ? "bg-amber-900/40 text-amber-200 hover:bg-amber-900/60"
                              : "text-muted hover:text-white hover:bg-raised"
                          }`}
                        >
                          <Ban size={16} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <DetailTabs
                    hasGen={!!data.gen?.source}
                    tagCount={flowTags.length}
                    generation={
                      <GenPanel
                        imageId={data._id}
                        gen={data.gen}
                        width={data.width}
                        height={data.height}
                        onCopyAll={() => void copyWorkflow()}
                      />
                    }
                    tags={
                      // Keyed: an AI job belongs to the image it was started on.
                      <TagsSection
                        key={data._id}
                        id={data._id}
                        onCopyAll={() => void copyAllTags()}
                        onChange={onTagsChanged}
                        tags={flowTags}
                      />
                    }
                  />
                </div>
              </PanelFit.Provider>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

type DetailTab = "generation" | "tags";
const DETAIL_TAB_KEY = "imageView:tab";

function readDetailTab(): DetailTab {
  try {
    return localStorage.getItem(DETAIL_TAB_KEY) === "tags" ? "tags" : "generation";
  } catch {
    return "generation";
  }
}

/**
 * Generation data and tags as two tabs, so neither waits below the other.
 * Generation first: most people come back to an image for its recipe. The
 * last tab picked sticks across images and visits, so a tagging session
 * stays on Tags. An image with no generation data shows its tags alone.
 */
/** Where a tab's actions go: the tab bar's right end (null: no bar). */
const TabActionsSlot = React.createContext<HTMLElement | null>(null);

/** A tab's actions ("Copy all", "Remix"), drawn at the tab bar's right end,
 * or as a row of their own when the panel has no tab bar. */
function TabActions({ children }: { children: React.ReactNode }) {
  const slot = React.useContext(TabActionsSlot);
  if (slot) return createPortal(children, slot);
  return <div className="flex items-center justify-end gap-1">{children}</div>;
}

/** An icon-only action in a tab's action row. */
const TAB_ACTION = "p-2 rounded-lg text-muted hover:text-white hover:bg-raised transition-colors";

function DetailTabs({
  hasGen,
  tagCount,
  generation,
  tags,
}: {
  hasGen: boolean;
  tagCount: number;
  generation: React.ReactNode;
  tags: React.ReactNode;
}) {
  const [picked, setPicked] = useState<DetailTab>(readDetailTab);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const tab: DetailTab = hasGen ? picked : "tags";
  const pick = (next: DetailTab) => {
    setPicked(next);
    try {
      localStorage.setItem(DETAIL_TAB_KEY, next);
    } catch {
      // Non-fatal; the choice just won't survive a reload.
    }
  };
  if (!hasGen) return <>{tags}</>;
  const tabs: { id: DetailTab; label: string; count?: number }[] = [
    { id: "generation", label: "Generation" },
    { id: "tags", label: "Tags", count: tagCount },
  ];
  return (
    <>
      {/* Sticks under the panel header while its tab scrolls. */}
      <div className="sticky top-0 z-10 flex items-center gap-1 pl-2 pr-3 border-b border-line bg-surface">
      <div role="tablist" aria-label="Image details" className="flex gap-1">
        {tabs.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => pick(t.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors ${
                on ? "border-brand-400 text-neutral-50 font-medium" : "border-transparent text-muted hover:text-neutral-100"
              }`}
            >
              {t.label}
              {!!t.count && <span className="text-xs text-faint tabular-nums">{t.count}</span>}
            </button>
          );
        })}
      </div>
      <div ref={setSlot} className="ml-auto flex items-center gap-1" />
      </div>
      <TabActionsSlot.Provider value={slot}>
        <div role="tabpanel">{tab === "generation" ? generation : tags}</div>
      </TabActionsSlot.Provider>
    </>
  );
}

/** A quiet text action for a section header ("Copy all", "Tag with AI"). */
const HEADER_ACTION = "inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200";

function TagsSection({
  id,
  onCopyAll,
  onChange,
  tags,
}: {
  id: string;
  onCopyAll: () => void;
  onChange: () => void;
  tags: FlowTag[];
}) {
  const { start, adopt, cancel, submitting, cancelling, jobId, job, canCancel } =
    useAiTagging(onChange, id);
  const hasTags = tags.length > 0;
  // The tagger has already run on it: no "Tag with AI" to offer.
  const aiTagged = tags.some((t) => t.kind === "ai" || t.kind === "character");
  const confirm = useConfirm();
  const retag = async () => {
    const ok = await confirm({
      title: "Re-tag this image with AI?",
      message:
        "All of its AI tags are removed and its rating is reset, then the tagger runs again. Your own tags and prompt tags stay.",
      confirmLabel: "Remove and re-tag",
      tone: "warning",
    });
    if (!ok) return;
    await start([id], { retag: true });
    // Show the cleared tags now; the job's end refreshes again.
    onChange();
  };
  const { data: tasks } = useBackgroundTasks();
  // A job tagging this image that the panel doesn't know (after a reload,
  // or from another tab); one started here it picks up by itself.
  const running = tasks?.find((t) => t.kind === "ai_job" && t.image_id === id)?.job_id;
  useEffect(() => {
    if (running) adopt(running);
  }, [running, adopt]);
  // The tagging model is shared: its download or load shows on every
  // image's panel, whichever image started it.
  const model = tasks?.find((t) => t.kind === "model_download" || t.kind === "model_load");
  const modelView = model ? describeTask(model) : null;
  const busy = submitting || Boolean(jobId);
  // This image's job, when it has one, names the line (its X cancels the
  // job); the model's progress shows on it while the job waits for it.
  const waitsForModel = !busy || job?.phase === "model";
  const jobLabel = submitting
    ? "Starting…"
    : aiJobLabel(job ?? (jobId ? { status: "queued" } : null));

  return (
    <section className="px-4 py-4 space-y-3">
      <TabActions>
        {/* While it runs, the status line below says so. */}
        {!busy &&
          (aiTagged ? (
            <button
              type="button"
              onClick={() => void retag()}
              className={TAB_ACTION}
              title="Re-tag with AI: remove its AI tags and rating, and tag it again"
              aria-label="Re-tag with AI"
            >
              <RotateCcw size={15} />
            </button>
          ) : (
            // Untagged, tagging is the thing to do here: worth its words.
            <button
              type="button"
              onClick={() => void start([id])}
              className={HEADER_ACTION}
              title="Tag this image with the AI tagger"
            >
              <Sparkles size={12} /> Tag with AI
            </button>
          ))}
        {hasTags && (
          <button
            type="button"
            onClick={onCopyAll}
            className={TAB_ACTION}
            title="Copy all tags as prompt text"
            aria-label="Copy all tags"
          >
            <Copy size={15} />
          </button>
        )}
      </TabActions>
      {(busy || modelView) && (
        <AiTagStatus
          label={(busy ? jobLabel : modelView?.title) ?? "Tagging…"}
          pct={waitsForModel ? (modelView?.pct ?? null) : null}
          onCancel={canCancel ? () => void cancel() : undefined}
          cancelling={cancelling || job?.status === "cancelling"}
        />
      )}
      {!hasTags && <div className="text-xs text-faint">No tags yet.</div>}
      {/* Adding sits where the tags end, as one more pill in the run. One
          place either way, so the open field survives the first tag. */}
      <TagFlow tags={tags} trailing={<AddTags id={id} onAdded={onChange} />} />
    </section>
  );
}

/** One line for this image's AI tagging: the shared model's download or
 * load, else the job's own state. */
function AiTagStatus({
  label,
  pct,
  onCancel,
  cancelling,
}: {
  label: string;
  pct: number | null;
  onCancel?: () => void;
  cancelling: boolean;
}) {
  return (
    <div role="status" className="rounded-lg bg-raised/50 px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <Loader2 size={12} className="shrink-0 animate-spin text-brand-300" />
        <Link
          to="/ai-tagging"
          className="min-w-0 flex-1 truncate text-neutral-200 hover:text-white"
          title="AI tagging jobs"
        >
          {label}
        </Link>
        {pct != null && <span className="tabular-nums text-faint">{pct}%</span>}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="-mr-1 rounded p-0.5 text-muted hover:bg-line hover:text-neutral-100 disabled:opacity-50"
            title="Cancel AI tagging"
            aria-label="Cancel AI tagging"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {pct != null && <ProgressBar value={pct} className="h-1" aria-label={label} />}
    </div>
  );
}

/**
 * Manual tags: a small "Add tags" pill that opens into a field, so it costs
 * one line until used. Takes several at once, comma separated; stays open
 * after adding for more, and closes on Escape or when left empty.
 */
function AddTags({ id, onAdded }: { id: string; onAdded: () => void }) {
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const [adding, setAdding] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const tags = val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const add = async () => {
    if (adding || !tags.length) return;
    setAdding(true);
    try {
      await applyTags(id, tags);
      setVal("");
      onAdded();
      // Back to the field for more (the + button took the focus).
      field.current?.focus();
    } catch (e) {
      push(`Couldn't add tags: ${String(e)}`, "error");
    } finally {
      setAdding(false);
    }
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Add your own tags"
        className="inline-flex items-center gap-0.5 h-5 px-1.5 rounded-full border border-dashed border-line text-2xs text-muted hover:text-neutral-100 hover:border-line-strong align-middle"
      >
        <Plus size={11} /> Add tags
      </button>
    );
  }
  return (
    <form
      className="relative mt-1"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <Input
        ref={field}
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setVal("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!val.trim() && !adding) setOpen(false);
        }}
        placeholder="Tags, comma separated"
        aria-label="Add tags"
        className="h-8 text-xs pr-9"
      />
      <button
        type="submit"
        disabled={adding || !tags.length}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted hover:bg-raised hover:text-neutral-100 disabled:opacity-40 disabled:pointer-events-none"
        title={tags.length > 1 ? `Add ${tags.length} tags` : "Add tag"}
        aria-label="Add tags"
      >
        {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
      </button>
    </form>
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

const KIND_TEXT: Record<TagKind, string> = {
  character: "text-brand-300 font-semibold",
  ai: "text-neutral-100",
  manual: "text-emerald-300",
  // Not coloured apart: once AI-tagged, prompt-only tags sit under their own
  // heading, and before that every tag is one. Grey here read as "unsure".
  prompt: "text-neutral-100",
};
const KIND_NOUN: Record<TagKind, string> = {
  character: "Character",
  ai: "AI tag",
  manual: "Your tag",
  prompt: "Prompt tag",
};
const ALSO_TEXT = { manual: "yours", prompt: "in the prompt" } as const;

/** The hover bubble's second line: what the tag is, what else stored the
 * same name, and how sure the tagger was. */
function tagDetail(t: FlowTag): string {
  const parts = [KIND_NOUN[t.kind]];
  if (t.also?.length) parts.push(`also ${t.also.map((k) => ALSO_TEXT[k]).join(" and ")}`);
  if (t.confidence != null) parts.push(`${Math.round(t.confidence * 100)}% confident`);
  return parts.join(" · ");
}

// One step, not a fade by confidence: a fade made sure tags look half-unsure
// and blurred into everything else drawn lighter. Below this, a tag is dimmed.
const UNSURE_BELOW = 0.5;
const UNSURE_OPACITY = 0.55;
const unsure = (t: FlowTag) => t.confidence != null && t.confidence < UNSURE_BELOW;

// The side panel's background (tailwind `surface`): what a rainbow-outlined
// tag paints inside its border.
const PANEL_GROUND = "#15141c";

// Prompt adherence groups, in reading order. The swatch colours the group's
// share of the summary bar: what the prompt got in brand, what the
// tagger added in a quieter brand, what the prompt missed in amber.
const GROUPS: { id: TagGroup; label: string; swatch: string }[] = [
  { id: "matched", label: "Prompted and seen", swatch: "bg-brand-400" },
  { id: "unprompted", label: "Seen, not prompted", swatch: "bg-brand-400/35" },
  { id: "missed", label: "Prompted, not seen", swatch: "bg-amber-400/80" },
  { id: "mine", label: "Your tags", swatch: "bg-emerald-400/80" },
];

/**
 * An image's tags as comma-separated runs, like a prompt: dense, easy to read
 * top to bottom and to copy. With both a prompt and AI tags, they split by
 * prompt adherence (lib/tags.ts adherenceGroups) under a bar of how much of
 * the prompt the tagger saw, and a tint marks each tag's facet (look,
 * outfit, pose...); otherwise by facet, under headings. An unsure AI tag is dimmed one step, and hair and eye tags are
 * outlined in their colour (lib/tagColour.ts). Each tag opens its tag page (a
 * character's, its character page).
 */
// Tag runs: roomier than body text, so a long list reads as tags, not a wall.
const RUN_TEXT = "text-sm leading-8";

const FACET_ORDER = Object.keys(FACET_LABEL) as Facet[];

/** A tag group's heading: a quiet caption with its count. */
function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-0.5 flex items-baseline gap-1.5 text-2xs uppercase tracking-wide text-faint">
      {label}
      <span className="tabular-nums text-line-strong">{count}</span>
    </div>
  );
}

function TagFlow({ tags, trailing }: { tags: FlowTag[]; trailing?: React.ReactNode }) {
  const { data: facets } = useTagFacets();
  const facetOf = (raw: string): Facet | null => facets?.[tagName(raw).toLowerCase()] ?? null;
  // Boilerplate (Settings) folds into one quiet toggle at the end, so the
  // tags that describe this image lead instead of "masterpiece, best quality".
  const isBoilerplate = useBoilerplate();
  const { kept, boilerplate } = useMemo(
    () => splitBoilerplate(tags, (t) => t.raw, isBoilerplate),
    [tags, isBoilerplate],
  );
  const [showBoilerplate, setShowBoilerplate] = useState(false);
  const groups = useMemo(() => adherenceGroups(kept), [kept]);
  const shown = showBoilerplate ? [...kept, ...boilerplate] : kept;
  // Ungrouped, your own tags are told apart by colour alone: key it.
  const keyMine = !groups && kept.some((t) => t.kind === "manual");
  const marks = useTagMarks();
  // Facet groups when there is no prompt/AI split to show; one run if every
  // tag lands in the same one (facets still loading, or all "other").
  const byFacet = useMemo(() => {
    if (groups) return null;
    const out = new Map<Facet | null, FlowTag[]>();
    for (const f of [...FACET_ORDER, null]) out.set(f, []);
    for (const t of kept) out.get(facets?.[tagName(t.raw).toLowerCase()] ?? null)!.push(t);
    const filled = [...out].filter(([, list]) => list.length);
    return filled.length > 1 ? filled : null;
  }, [groups, kept, facets]);
  // Under facet headings the tints need no key.
  const shownFacets = marks.tints && !byFacet
    ? (Object.keys(FACET_TINT) as Facet[]).filter((f) => shown.some((t) => facetOf(t.raw) === f))
    : [];
  const run = (list: FlowTag[]) =>
    list.map((t, i) => (
      <React.Fragment key={t.raw}>
        <Tooltip
          bubble
          side="up"
          className="inline"
          content={
            <>
              <div className="font-medium">{t.label}</div>
              <div className="text-xs text-muted">{tagDetail(t)}</div>
            </>
          }
        >
          <Link
            to={tagPageHref(t)}
            className={`rounded px-0.5 -mx-0.5 ${TAG_TINT_CLASS} hover:bg-raised hover:underline ${KIND_TEXT[t.kind]}`}
            style={{
              ...tagMarkStyle(t.raw, facetOf(t.raw), PANEL_GROUND, marks),
              ...(unsure(t) ? { opacity: UNSURE_OPACITY } : {}),
            }}
          >
            {t.label}
          </Link>
        </Tooltip>
        {i < list.length - 1 && <span className="text-line-strong">, </span>}
      </React.Fragment>
    ));
  const boilerplateToggle = boilerplate.length > 0 && (
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
  );
  // What every layout ends on: boilerplate (folded, or shown dimmed after
  // its toggle) and the add-tags pill.
  const tail = (
    <>
      {boilerplateToggle}
      {showBoilerplate && <span className="opacity-50"> {run(boilerplate)}</span>}
      {boilerplate.length > 0 && trailing && " "}
      {trailing}
    </>
  );
  const asked = groups ? groups.matched.length + groups.missed.length : 0;
  return (
    <div className="space-y-4">
      {groups ? (
        <>
          {/* How much of the prompt shows in the image, and what came unasked. */}
          {asked > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-neutral-200">
                  <span className="text-sm font-semibold tabular-nums">{groups.matched.length}</span>
                  <span className="text-muted"> of {asked} prompted tags seen</span>
                </span>
                {groups.unprompted.length > 0 && (
                  <span className="text-faint tabular-nums">+{groups.unprompted.length} unprompted</span>
                )}
              </div>
              <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
                {GROUPS.filter((g) => g.id !== "mine").map((g) =>
                  groups[g.id].length ? (
                    <div key={g.id} className={g.swatch} style={{ flexGrow: groups[g.id].length }} />
                  ) : null,
                )}
              </div>
            </div>
          )}
          {GROUPS.map((g) =>
            groups[g.id].length ? (
              <div key={g.id}>
                <GroupHeading label={g.label} count={groups[g.id].length} />
                <div className={RUN_TEXT}>{run(groups[g.id])}</div>
              </div>
            ) : null,
          )}
          {/* A div, not a p: the trailing add-tags field is a form. */}
          <div className={RUN_TEXT}>{tail}</div>
        </>
      ) : byFacet ? (
        <>
          {byFacet.map(([f, list]) => (
            <div key={f ?? "other"}>
              <GroupHeading label={f ? FACET_LABEL[f] : "other"} count={list.length} />
              <div className={RUN_TEXT}>{run(list)}</div>
            </div>
          ))}
          <div className={RUN_TEXT}>{tail}</div>
        </>
      ) : (
        <div className={RUN_TEXT}>
          {run(kept)}
          {kept.length > 0 && " "}
          {tail}
        </div>
      )}
      {(keyMine || shown.some(unsure) || shownFacets.length > 0) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-faint">
          {keyMine && <span className={KIND_TEXT.manual}>yours</span>}
          {shown.some(unsure) && <span style={{ opacity: UNSURE_OPACITY }}>fainter = less confident</span>}
          {shownFacets.map((f) => (
            <span key={f} className="rounded px-1 text-neutral-200" style={{ backgroundColor: FACET_TINT[f] }}>
              {FACET_LABEL[f]}
            </span>
          ))}
        </div>
      )}
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

/** The details panel's scroller and the content inside it. */
const PanelFit = React.createContext<{ scroller: HTMLElement; content: HTMLElement } | null>(null);

// "Show more" and its top margin.
const TOGGLE_HEIGHT = 20;

/**
 * Prompt / negative-prompt text. With `fit` (the prompt: what most people
 * open an image for), it shows as many lines as fill the panel without making
 * it scroll, so a short panel isn't left empty below a clipped prompt nor a
 * full one pushed into scrolling; past that, "Show more". Otherwise 3 lines.
 */
function PromptBlock({ text, fit = false }: { text: string; fit?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [lines, setLines] = useState<number | null>(fit ? null : 3);
  const panel = React.useContext(PanelFit);
  const block = useRef<HTMLDivElement>(null);
  const para = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const box = block.current;
    const p = para.current;
    if (!box || !p || expanded) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(p).lineHeight) || 20;
      if (!fit || !panel) {
        setLines(p.scrollHeight > 3 * lineHeight + 1 ? 3 : null);
        return;
      }
      // What the rest of the panel takes, whatever this block shows now.
      const others = panel.content.offsetHeight - box.offsetHeight;
      setLines(
        fitLines({
          available: panel.scroller.clientHeight - others,
          lineHeight,
          fullHeight: p.scrollHeight,
          toggleHeight: TOGGLE_HEIGHT,
        }),
      );
    };
    measure();
    // Again when the panel resizes or its other content lands or folds
    // (characters, the outfit board, the workflow line); this block's own
    // resize measures the same. Committed at once: the observer runs before
    // the frame paints, a plain update after it, which showed the old clamp
    // pushed down for a frame.
    const ro = new ResizeObserver(() => flushSync(measure));
    ro.observe(p);
    if (fit && panel) {
      ro.observe(panel.scroller);
      ro.observe(panel.content);
    }
    return () => ro.disconnect();
  }, [text, expanded, fit, panel]);
  const clamped = !expanded && lines != null;
  return (
    <div ref={block}>
      <p
        ref={para}
        className="text-sm text-neutral-300 whitespace-pre-wrap break-words"
        style={
          clamped
            ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }
            : undefined
        }
      >
        {text}
      </p>
      {(clamped || expanded) && (
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
function GuessedBadge({ onResolve }: { onResolve?: () => void }) {
  return (
    <>
    <span
      className="text-2xs px-1.5 py-0.5 rounded-md border border-amber-400/30 text-amber-300"
      title="Picked by keyword match: the workflow doesn't show where its prompt goes. Resolve it to be certain."
    >
      Guessed
    </span>
    {onResolve && (
      <button type="button" onClick={onResolve} className="text-2xs text-brand-300 hover:text-brand-200">
        Resolve
      </button>
    )}
    </>
  );
}

function GenPanel({
  imageId,
  gen,
  width,
  height,
  onCopyAll,
}: {
  imageId: string;
  gen?: import("../lib/gen").GenMeta;
  width?: number;
  height?: number;
  onCopyAll: () => void;
}) {
  const { data: remix } = useRemix(imageId, !!gen?.source);
  const [resolving, setResolving] = useState<"prompt" | "negative" | null>(null);
  const qc = useQueryClient();
  // The pin re-reads the workflow's images in the background: look again as it lands.
  const reread = () => {
    for (const ms of [800, 3000]) window.setTimeout(() => void qc.invalidateQueries({ queryKey: imageDocKey(imageId) }), ms);
  };
  if (!gen || !gen.source) return null;
  // Until the read lands (or if it fails), what the image's own data says,
  // so the header doesn't jump.
  const info: RemixInfo = remix ?? {
    image_id: imageId,
    source: gen.source,
    workflow:
      gen.source === "comfyui" && gen.workflow_sig
        ? { family: null, family_name: null, file_name: null, workflow_sig: gen.workflow_sig }
        : null,
    seed: gen.seed ?? null,
    batch: null,
  };
  const editRule = gen.workflow_sig && (
    <Link
      to={`/rules?sig=${encodeURIComponent(gen.workflow_sig)}`}
      className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
      title="Edit this workflow's extraction rule"
    >
      <Workflow size={12} /> Edit rule
    </Link>
  );
  return (
    <section className="px-4 py-4 space-y-4">
      {resolving && <ResolvePromptDialog open onClose={() => setResolving(null)} gen={gen} field={resolving} onSaved={reread} />}
      <TabActions>
        {!info.workflow && editRule}
        <RemixButton info={info} />
        {/* Copy sits last in every tab's actions. */}
        <button
          type="button"
          onClick={onCopyAll}
          className={TAB_ACTION}
          title="Copy all generation data"
          aria-label="Copy all generation data"
        >
          <Copy size={15} />
        </button>
      </TabActions>

      {info.workflow && (
        <div className="space-y-1.5 border-y border-line py-2">
          <WorkflowLine info={info} imageId={imageId} />
          {editRule}
        </div>
      )}

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
              {gen.guessed?.includes("prompt") && <GuessedBadge onResolve={gen.workflow_sig ? () => setResolving("prompt") : undefined} />}
            </div>
            <CopyButton text={gen.prompt} label="Prompt" />
          </div>
          <PromptBlock text={gen.prompt} fit />
        </div>
      )}

      {gen.negative && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">Negative prompt</div>
              {gen.guessed?.includes("negative") && <GuessedBadge onResolve={gen.workflow_sig ? () => setResolving("negative") : undefined} />}
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
