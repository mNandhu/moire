import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorText } from "../lib/api";
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, Ban, Download, FolderOpen, PanelRight } from "lucide-react";
import { imageFileUrl } from "../lib/media";
import { useToast } from "../components/Toasts";
import { ImageCharacters } from "../components/ImageCharacters";
import { parseFilters, serializeFiltersForPeek } from "../lib/imageFilter";
import { fetchImage } from "../lib/imageApi";
import { IMAGE_DOC_STALE_MS, useImageStepper } from "../hooks/useImageStepper";
import { fetchWorkflow, workflowClipboardText } from "../lib/rules";
import {
  setScore as apiSetScore,
  setQuarantine as apiSetQuarantine,
} from "../lib/imageMutations";
import { accentFromBlurhash } from "../lib/blurhash";
import { pickRating } from "../lib/rating";
import { tagFlow, toPromptText } from "../lib/tags";
import { splitBoilerplate } from "../lib/boilerplate";
import { libraryPageHref, useBoilerplate, useLibraries } from "../lib/queries";
import { useHotkeys } from "../hooks/useHotkeys";
import { SHEET_PEEK, useDetailsSheet } from "../hooks/useDetailsSheet";
import { IMAGE, isPrevImage } from "../lib/shortcuts";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { ScorePicker } from "../components/ui/ScoreMark";
import { GenPanel, PanelFit } from "../components/imageview/GenPanel";
import { RatingEditor } from "../components/imageview/RatingEditor";
import { DetailTabs } from "../components/imageview/DetailTabs";
import { TagsSection } from "../components/imageview/TagsSection";

// Round controls floating over the image stage (back, details, prev/next).
const OVERLAY_BTN =
  "p-2 rounded-full bg-black/45 border border-white/10 text-white/80 hover:text-white hover:bg-black/65 disabled:opacity-30 disabled:pointer-events-none transition-colors duration-150";
import { imageDocKey, invalidateFeeds, removeImageFromFeeds, syncFeedsFromDoc, writeImageFields } from "../lib/feedCache";

export default function ImageView() {
  // `routeId` is where the URL points; `id` is the image actually on screen
  // (see useImageStepper).
  const { id: routeId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { push } = useToast();
  const queryClient = useQueryClient();
  // On a phone the panel is a sheet over the image's lower part (see useDetailsSheet).
  const phone = useMediaQuery("(max-width: 639px)");
  const { infoOpen, setInfoOpen, open, sheet, setSheet, dragging, sheetDrag, sheetStyle, asideRef } = useDetailsSheet(phone);
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
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Image filter carried in the URL, drives the shared Image feed so the
  // pages the gallery already fetched are reused here (no separate paging code).
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const { id, shown, pending, index, list, fileUrl, goPrev, goNext, goBack, hasMore } =
    useImageStepper(filters, routeId);
  // Current image document (full doc with tags/rating); refetched after edits.
  const { data, refetch, dataUpdatedAt } = useQuery({
    queryKey: imageDocKey(id!),
    queryFn: ({ signal }) => fetchImage(id!, { signal }),
    enabled: !!id,
    // Matches the neighbour prefetch in useImageStepper, so arriving on a prefetched image
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
      // Shown at once, here and on the gallery tile; undone if the write fails.
      try {
        await writeImageFields(queryClient, canonical, { score: n }, () => apiSetScore(id, n), id);
        refreshImage();
      } catch (e) {
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

  // Blur-up placeholder shown under the original while it loads. Reuses the
  // exact thumb URL the gallery tile rendered (when the feed item is known)
  // so the browser serves it from cache instead of refetching; the thumb is
  // almost always already decoded from scrolling past it in the grid. Read
  // off `shown` (the image on screen), not the route target, which would show
  // the *next* image's thumb under the current one while a step is held.
  // A deep link's image isn't in the feed: its doc carries the URL.
  const thumbUrl = (id && (shown?.thumb_url ?? data?.thumb_url)) || null;
  const [thumbFailed, setThumbFailed] = useState(false);
  useEffect(() => {
    setThumbFailed(false);
  }, [thumbUrl]);

  // This view IS the overlay, so it keeps listening while one is open.
  useHotkeys(
    [
      {
        ...IMAGE.step,
        run: (e) => {
          e.preventDefault();
          if (isPrevImage(e.key)) goPrev();
          else goNext();
        },
      },
      {
        ...IMAGE.back,
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
        ...IMAGE.score,
        run: (e) => {
          if (pending) return;
          e.preventDefault();
          void applyScore(Number(e.key));
        },
      },
      {
        ...IMAGE.quarantine,
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
    // ComfyUI reads `hu_tao_(genshin_impact)` as a tag, not as emphasis;
    // prompted weights kept.
    const text = toPromptText(all, data?.gen?.prompt_weights);
    try {
      await navigator.clipboard.writeText(text);
      push("Tags copied to clipboard", "success");
    } catch (e) {
      push(`Copy failed: ${errorText(e)}`, "error");
    }
  }, [data?.tags, data?.gen?.prompt_weights, push]);

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
  const weights = data?.gen?.prompt_weights;
  const flowTags = useMemo(() => tagFlow(data?.tags, data?.ai, weights), [data?.tags, data?.ai, weights]);
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
  const stageW = shown?.width ?? data?.width;
  const stageH = shown?.height ?? data?.height;

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
            onClick={open}
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
              width={shown?.width ?? data?.width ?? undefined}
              height={shown?.height ?? data?.height ?? undefined}
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
                infoOpen || dragging ? "shadow-xl shadow-black/50" : ""
              }`
            : `fixed lg:static inset-y-0 right-0 z-[60] h-dvh lg:h-full w-full sm:w-[380px] lg:w-[400px] lg:shrink-0 flex flex-col border-l border-line bg-surface shadow-xl shadow-black/30 lg:shadow-none transition-transform duration-300 ease-out lg:transition-none ${
                infoOpen ? "translate-x-0 lg:flex" : "translate-x-full lg:hidden"
              }`
        }
        style={sheetStyle}
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
                  href={fileUrl || imageFileUrl(data._id)}
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
                        width={data.width ?? undefined}
                        height={data.height ?? undefined}
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
