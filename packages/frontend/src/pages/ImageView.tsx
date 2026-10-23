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
import { getBackgroundLocation } from "../lib/backgroundLocation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorText } from "../lib/api";
import { ArrowLeft, ChevronLeft, ChevronRight, Sparkles, RotateCcw, Loader2, Copy, Ban, Download, FolderOpen, PanelRight, Plus, X } from "lucide-react";
import { resolveMediaUrl } from "../lib/media";
import { useToast } from "../components/Toasts";
import { ImageCharacters } from "../components/ImageCharacters";
import { parseFilters, serializeFilters, serializeFiltersForPeek, fetchImage } from "../lib/imageFilter";
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
} from "../lib/imageMutations";
import { accentFromBlurhash } from "../lib/blurhash";
import { pickRating } from "../lib/rating";
import { tagFlow, toPromptText, type FlowTag } from "../lib/tags";
import { splitBoilerplate } from "../lib/boilerplate";
import { libraryPageHref, useBoilerplate, useLibraries } from "../lib/queries";
import { useHotkeys } from "../hooks/useHotkeys";
import { snapSheet } from "../lib/sheetSnap";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { ScorePicker } from "../components/ui/ScoreMark";
import { Input } from "../components/ui/Input";
import { useConfirm } from "../components/ConfirmDialog";
import { TagFlow } from "../components/imageview/TagFlow";
import { GenPanel, PanelFit } from "../components/imageview/GenPanel";
import { TabActions, TabActionsSlot, TAB_ACTION } from "../components/imageview/TabActions";
import { RatingEditor } from "../components/imageview/RatingEditor";

// Round controls floating over the image stage (back, details, prev/next).
const OVERLAY_BTN =
  "p-2 rounded-full bg-black/45 border border-white/10 text-white/80 hover:text-white hover:bg-black/65 disabled:opacity-30 disabled:pointer-events-none transition-colors duration-150";
import { imageDocKey, invalidateFeeds, patchImageEverywhere, removeImageFromFeeds, syncFeedsFromDoc } from "../lib/feedCache";

// How long a fetched image doc stays fresh. Shared by the current-image query
// and the neighbour prefetch so stepping through the feed reuses prefetched
// docs rather than refetching them.
const IMAGE_DOC_STALE_MS = 30_000;

// Longest the view will hold the previous image while waiting on the next one
// to decode. Past this we show it regardless rather than appear stuck.
const MAX_HOLD_MS = 2000;

// The phone's details sheet: how much of it shows at rest, below the image.
const SHEET_PEEK = "45dvh";
const SHEET_PEEK_FRACTION = 0.45;

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
  // On a phone the panel is a sheet over the image's lower part: resting at
  // a peek, under the image, or pulled up to read; dragged by its top.
  const phone = useMediaQuery("(max-width: 639px)");
  const [sheet, setSheet] = useState<"peek" | "full">("peek");
  const asideRef = useRef<HTMLElement>(null);
  const [dragY, setDragY] = useState<number | null>(null);
  const dragRef = useRef<{ y0: number; from: number; y: number; t: number; v: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  // Down from fully open, px: open, peek, closed.
  const sheetStops = () => {
    const h = asideRef.current?.offsetHeight ?? window.innerHeight;
    return [0, h - window.innerHeight * SHEET_PEEK_FRACTION, h];
  };
  const sheetDrag: React.HTMLAttributes<HTMLDivElement> = phone
    ? {
        style: { touchAction: "none" },
        onPointerDown: (e) => {
          // A drag on touch ends without a click to clear this; a new press does.
          justDragged.current = false;
          // Typing and picking in a field aren't drags.
          if (e.button || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
          const stops = sheetStops();
          dragRef.current = {
            y0: e.clientY,
            from: sheet === "full" ? stops[0] : stops[1],
            y: e.clientY,
            t: e.timeStamp,
            v: 0,
            moved: false,
          };
        },
        onPointerMove: (e) => {
          const d = dragRef.current;
          if (!d) return;
          const dy = e.clientY - d.y0;
          // A tap on a header button stays a tap.
          if (!d.moved) {
            if (Math.abs(dy) < 6) return;
            d.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          const dt = e.timeStamp - d.t;
          if (dt > 0) d.v = (e.clientY - d.y) / dt;
          d.y = e.clientY;
          d.t = e.timeStamp;
          setDragY(Math.max(0, d.from + dy));
        },
        onPointerUp: (e) => {
          const d = dragRef.current;
          dragRef.current = null;
          if (!d?.moved) return;
          justDragged.current = true;
          // Held still before letting go: no flick.
          const v = e.timeStamp - d.t > 80 ? 0 : d.v;
          const stop = snapSheet(Math.max(0, d.from + e.clientY - d.y0), v, sheetStops());
          setDragY(null);
          if (stop === 2) setInfoOpen(false);
          else setSheet(stop === 0 ? "full" : "peek");
        },
        onPointerCancel: () => {
          dragRef.current = null;
          setDragY(null);
        },
        // The click that ends a drag isn't a press of what it started on.
        onClickCapture: (e) => {
          if (!justDragged.current) return;
          justDragged.current = false;
          e.preventDefault();
          e.stopPropagation();
        },
      }
    : {};
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
        push(`Failed to set score: ${errorText(e)}`, "error");
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
      push(`Failed to update quarantine: ${errorText(e)}`, "error");
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
      push(`Copy failed: ${errorText(e)}`, "error");
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

  // This view IS the overlay, so it keeps listening while one is open.
  useHotkeys(
    [
      {
        keys: ["ArrowLeft"],
        run: (e) => {
          e.preventDefault();
          goPrev();
        },
      },
      {
        keys: ["ArrowRight"],
        run: (e) => {
          e.preventDefault();
          goNext();
        },
      },
      {
        keys: ["Escape"],
        run: (e) => {
          e.preventDefault();
          goBack();
        },
      },
      // Curation acts on the image on screen. While the view is held mid-swap
      // that is not the one the URL has moved to, so ignore these until the
      // stage and the route agree; better than scoring an image you have
      // already stepped past.
      // Curation: 1-5 set score, 0 clears, X quarantines/restores.
      {
        match: (e) => e.key >= "0" && e.key <= "5",
        run: (e) => {
          if (pending) return;
          e.preventDefault();
          void applyScore(Number(e.key));
        },
      },
      {
        keys: ["x", "X", "Delete"],
        run: (e) => {
          if (pending) return;
          e.preventDefault();
          void toggleQuarantine();
        },
      },
    ],
    { overlay: "ignore" },
  );

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
      push(`Copy failed: ${errorText(e)}`, "error");
    }
  }, [data?.tags, push]);

  const copyPath = useCallback(async () => {
    if (!data?.path) return;
    try {
      await navigator.clipboard.writeText(data.path);
      push("Path copied to clipboard", "success");
    } catch (e) {
      push(`Copy failed: ${errorText(e)}`, "error");
    }
  }, [data?.path, push]);

  useDocumentTitle(data?.path ? data.path.split(/[\\/]/).pop() : null);
  const { data: libraries } = useLibraries({ poll: false });
  const library = libraries?.find((l) => l._id === data?.library_id);
  const flowTags = useMemo(() => tagFlow(data?.tags, data?.ai), [data?.tags, data?.ai]);
  // The Tags tab counts what its panel lists: folded boilerplate aside.
  const isBoilerplate = useBoilerplate();
  const shownTagCount = useMemo(
    () => splitBoilerplate(flowTags, (t) => t.raw, isBoilerplate).kept.length,
    [flowTags, isBoilerplate],
  );

  if (!id) return null;

  const fileName = data?.path ? data.path.split(/[\\/]/).pop() : "";
  const rating = pickRating(data);
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
        className="flex-1 h-full flex items-center justify-center relative overflow-hidden [container-type:size] transition-[padding] duration-300 ease-out"
        // The image sits above the resting sheet, not under it.
        style={phone && infoOpen ? { paddingBottom: SHEET_PEEK } : undefined}
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
            onClick={() => {
              setSheet("peek");
              setInfoOpen(true);
            }}
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
        ref={asideRef}
        role="region"
        aria-label="Image details"
        className={
          phone
            ? `fixed inset-x-0 bottom-0 z-[60] h-[92dvh] flex flex-col rounded-t-2xl border-t border-line-strong bg-surface transition-transform duration-300 ease-out ${
                // Closed, it sits just below the screen: no shadow up over the image.
                infoOpen || dragY != null ? "shadow-xl shadow-black/50" : ""
              }`
            : `fixed lg:static inset-y-0 right-0 z-[60] h-dvh lg:h-full w-full sm:w-[380px] lg:w-[400px] lg:shrink-0 flex flex-col border-l border-line bg-surface shadow-xl shadow-black/30 lg:shadow-none transition-transform duration-300 ease-out lg:transition-none ${
                infoOpen ? "translate-x-0 lg:flex" : "translate-x-full lg:hidden"
              }`
        }
        style={
          phone
            ? {
                transform:
                  dragY != null
                    ? `translateY(${dragY}px)`
                    : !infoOpen
                      ? "translateY(100%)"
                      : sheet === "peek"
                        ? `translateY(calc(100% - ${SHEET_PEEK}))`
                        : "none",
                transition: dragY != null ? "none" : undefined,
              }
            : undefined
        }
      >
        {phone && (
          <div {...sheetDrag} className="flex shrink-0 justify-center pt-1.5">
            <button
              type="button"
              onClick={() => setSheet(sheet === "full" ? "peek" : "full")}
              className="flex h-5 w-16 items-center justify-center"
              aria-label={sheet === "full" ? "Lower details" : "Raise details"}
            >
              <span className="h-1 w-10 rounded-full bg-line-strong" />
            </button>
          </div>
        )}
        {data && (
          <>
            {/* Header: filename + quick actions */}
            <div {...sheetDrag} className="flex items-start justify-between gap-2 px-4 py-3 max-sm:pt-1 border-b border-line shrink-0">
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
                  title={`${data.path}\nCopy path`}
                  className="group mt-1 flex max-w-full items-center gap-1 text-left text-xs text-faint hover:text-neutral-200"
                >
                  {/* One line: the file name it ends on is the header above. */}
                  <span className="truncate">{data.path}</span>
                  <Copy size={11} className="shrink-0 opacity-0 group-hover:opacity-100 touch:opacity-100" />
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
            <div
              // At peek the sheet's lower part is below the screen, so the
              // whole of it drags: a swipe up pulls it up to read, not a
              // scroll of content that can't be reached. Sideways stays the
              // browser's, for the batch strip and other rows that scroll.
              {...(sheet === "peek" && phone ? { ...sheetDrag, style: { touchAction: "pan-x" } } : {})}
              ref={setPanelScroller}
              className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
            >
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
                    tagCount={shownTagCount}
                    generation={
                      <GenPanel
                        imageId={data._id}
                        gen={data.gen}
                        width={data.width}
                        height={data.height}
                        onCopyAll={() => void copyWorkflow()}
                        batchScope={serializeFiltersForPeek(filters)}
                        thumbUrl={data.thumb_url}
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
 * Both panels stay mounted (the hidden one display:none): the tags panel
 * owns a running AI job's watch, which must outlive a look at Generation.
 */
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
      {/* Only the shown tab's actions go to the bar; the hidden one's stay
          in its own (hidden) row. */}
      <TabActionsSlot.Provider value={tab === "generation" ? slot : null}>
        <div role="tabpanel" hidden={tab !== "generation"}>{generation}</div>
      </TabActionsSlot.Provider>
      <TabActionsSlot.Provider value={tab === "tags" ? slot : null}>
        <div role="tabpanel" hidden={tab !== "tags"}>{tags}</div>
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
      <TagFlow key={id} tags={tags} trailing={<AddTags id={id} onAdded={onChange} />} />
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
      push(`Couldn't add tags: ${errorText(e)}`, "error");
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
