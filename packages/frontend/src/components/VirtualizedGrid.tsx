import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { ThumbnailTile } from "./ThumbnailTile";
import { scrollParent } from "../lib/dom";
import {
  columnWidth,
  gapForDensity,
  gridColumns,
  packColumns,
  scrollStep,
  visibleSlice,
  DEFAULT_DENSITY,
} from "../lib/masonryLayout";
import type { ImageDoc } from "../lib/imageFilter";
import type { PendingRestore } from "../hooks/useScrollRestoration";

type ImageDocWithDims = ImageDoc & { width?: number; height?: number };

interface VirtualizedGridProps {
  items: ImageDocWithDims[];
  selection: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  selectionMode: boolean;
  className?: string;
  getScrollContainer?: () => HTMLElement | null;
  focusedIndex?: number;
  /** Index into DENSITY_STEPS: how many columns to pack in. */
  density?: number;
  /** Hold quarantined tiles back visually. Off in the quarantined view, where
   * every tile is quarantined and dimming them all helps nobody. */
  dimQuarantined?: boolean;
  /** Scroll offset to jump to once the grid has packed; see the layout effect
   * below for why the grid owns this rather than the page. */
  restoreScrollTop?: PendingRestore | null;
  /** Active gallery filters, serialized for tiles' batch-peek fetch; see
   * serializeFiltersForPeek. */
  peekQuery?: string;
  /** Told the column count whenever it changes (arrow-key row jumps). */
  onColumns?: (cols: number) => void;
}

/** Longest entrance stagger, so a 200-item page doesn't trickle in for 4s. */
const MAX_STAGGER_MS = 240;
/** Per-tile stagger step. */
const STAGGER_STEP_MS = 18;
/** How long newly-appended tiles keep their entrance animation. */
const ENTRANCE_WINDOW_MS = 900;

/**
 * The gallery grid.
 *
 * Always virtualized. There used to be a second, CSS-grid implementation that
 * took over below 150 items, which meant the grid swapped implementations
 * mid-scroll on the first page boundary: a full remount from row-spans to
 * absolute positioning. The two also disagreed about column count (viewport
 * breakpoints vs container width), so keyboard row-jumps were wrong in one of
 * them. One implementation, one `gridColumns`, no swap.
 */
export function VirtualizedGrid({
  items,
  selection,
  onToggle,
  onOpen,
  selectionMode,
  className,
  getScrollContainer,
  focusedIndex = -1,
  density = DEFAULT_DENSITY,
  dimQuarantined = true,
  restoreScrollTop = null,
  peekQuery = "",
  onColumns,
}: VirtualizedGridProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const virtualContainerRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [scrollTop, setScrollTop] = useState(0);
  const [wrapperTop, setWrapperTop] = useState(0);
  // Only the *measurement* is state. Columns, column width and gutter are all
  // derived from it and the density in one place below.
  //
  // They used to be split: `gap` was computed inline from the density prop
  // while `cols`/`colWidth` were set by an effect. On a zoom step React
  // rendered once with the new gap against the previous width and count, so
  // every `+`/`-` press packed one frame of visibly wrong layout before the
  // effect landed. Deriving them together makes that state unrepresentable.
  const [wrapperWidth, setWrapperWidth] = useState(0);

  const { cols, colWidth, gap } = useMemo(() => {
    const c = gridColumns(wrapperWidth, density);
    const g = gapForDensity(density);
    return { cols: c, colWidth: columnWidth(wrapperWidth, c, g), gap: g };
  }, [wrapperWidth, density]);

  useEffect(() => {
    onColumns?.(cols);
  }, [cols, onColumns]);

  // The element the grid scrolls in. The page's getter can come back empty:
  // React attaches an ancestor's ref only after its children's layout effects,
  // so when the page and the grid mount in one commit (back to the gallery
  // with the feed cached) a getter reading a ref on the page sees null.
  // Bailing then left the grid unmeasured for good: 0 wide, no tiles, no
  // height, and the sentinel below it paging in the whole feed. The wrapper's
  // own ref is attached by then, so walk up from it to the scroller. Every
  // use below goes through here so they all agree on one element.
  const resolveScroller = useCallback(
    () => getScrollContainer?.() ?? scrollParent(wrapperRef.current),
    [getScrollContainer],
  );

  const recomputeLayout = (scrollEl: HTMLElement) => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    setWrapperWidth(wrapper.clientWidth);
    setViewportHeight(scrollEl.clientHeight || 600);
    // wrapper's top in scroll content coordinates
    const scrollRect = scrollEl.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const top = wrapperRect.top - scrollRect.top + scrollEl.scrollTop;
    setWrapperTop(top);
  };

  // Track scrollTop from the *outer* scroll container.
  //
  // A layout effect, not a passive one. `wrapperWidth` starts at 0, which makes
  // `colWidth` 0, which makes `packColumns` bail, so the first render of the
  // grid has no tiles at all. Measuring after paint meant the browser reliably
  // painted that empty frame, then a second frame with the tiles at the top of
  // the list, before anything landed where it belonged. Measuring before paint
  // collapses all of that into one correct first frame.
  useLayoutEffect(() => {
    const scrollEl = resolveScroller();
    const wrapper = wrapperRef.current;
    if (!scrollEl || !wrapper) return;

    // Coalesce scroll events to one update per animation frame, and track the
    // offset in SCROLL_STEP_PX steps: React skips a state set to the same
    // value, so the grid re-renders only when the scroll crosses a step.
    let rafId = 0;
    const handleScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        setScrollTop(scrollStep(scrollEl.scrollTop));
      });
    };

    // Initial
    recomputeLayout(scrollEl);
    setScrollTop(scrollStep(scrollEl.scrollTop));

    // Observe wrapper resize for column changes
    const ro = new ResizeObserver(() => recomputeLayout(scrollEl));
    ro.observe(wrapper);

    // Also keep viewport height + wrapperTop reasonably fresh
    const roScroll = new ResizeObserver(() => recomputeLayout(scrollEl));
    roScroll.observe(scrollEl);

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      roScroll.disconnect();
      scrollEl.removeEventListener("scroll", handleScroll);
    };
  }, [resolveScroller]);

  const { tiles, columns, totalHeight } = useMemo(
    () => packColumns(items, cols, colWidth, gap),
    [items, colWidth, cols, gap]
  );

  const visibleTiles = useMemo(
    () =>
      visibleSlice(columns, Math.max(0, scrollTop - wrapperTop), viewportHeight),
    [columns, scrollTop, viewportHeight, wrapperTop]
  );

  // Restore a saved scroll offset, once, in the first commit that has a real
  // height to scroll within.
  //
  // This has to live here rather than in `useScrollRestoration`: React runs
  // layout effects child-first, so a parent that scrolls the container would
  // run while the grid still measures 0px tall and the scroll would be clamped
  // straight back to the top. Here it runs in the same pre-paint pass that
  // sizes the grid, and seeds `scrollTop` so `visibleSlice` mounts the tiles
  // around the restored position instead of the ones at the top of the feed.
  const restoredKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!restoreScrollTop || totalHeight <= 0) return;
    if (restoredKeyRef.current === restoreScrollTop.key) return;
    const scrollEl = resolveScroller();
    if (!scrollEl) return;
    restoredKeyRef.current = restoreScrollTop.key;
    const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const top = Math.min(restoreScrollTop.top, max);
    scrollEl.scrollTop = top;
    setScrollTop(top);
  }, [restoreScrollTop, totalHeight, resolveScroller]);

  // Entrance animation for tiles a page-fetch just appended.
  //
  // Keyed on "index >= the count before this page arrived" rather than on
  // mount, because virtualization unmounts and remounts tiles constantly while
  // scrolling: animating on mount would make the grid flicker every time you
  // scrolled back up. The window closes on a timer so a tile that scrolls away
  // and returns comes back without re-animating.
  const knownCountRef = useRef(0);
  const [entranceFrom, setEntranceFrom] = useState<number>(Infinity);
  useEffect(() => {
    if (items.length > knownCountRef.current) {
      setEntranceFrom(knownCountRef.current);
    } else if (items.length < knownCountRef.current) {
      // Images were removed (a bulk quarantine drops them from the cache).
      // Nothing here is new, so nothing should animate; setting 0 would fade
      // the entire visible grid back in every time a batch completes.
      setEntranceFrom(Infinity);
    }
    knownCountRef.current = items.length;
  }, [items.length]);

  useEffect(() => {
    if (entranceFrom === Infinity) return;
    const t = setTimeout(() => setEntranceFrom(Infinity), ENTRANCE_WINDOW_MS);
    return () => clearTimeout(t);
  }, [entranceFrom]);

  // Keyboard-focused tile may be outside the rendered/visible window; scroll the
  // container so it shows (the layout knows every tile's y).
  useEffect(() => {
    if (focusedIndex < 0) return;
    const scrollEl = resolveScroller();
    const tile = tiles[focusedIndex];
    if (!scrollEl || !tile) return;
    const top = wrapperTop + tile.y;
    const bottom = top + tile.h;
    const viewTop = scrollEl.scrollTop;
    const viewBottom = viewTop + scrollEl.clientHeight;
    if (top < viewTop) {
      scrollEl.scrollTo({ top: Math.max(0, top - 12), behavior: "smooth" });
    } else if (bottom > viewBottom) {
      scrollEl.scrollTo({
        top: bottom - scrollEl.clientHeight + 12,
        behavior: "smooth",
      });
    }
  }, [focusedIndex, tiles, wrapperTop, resolveScroller]);

  return (
    <div ref={wrapperRef} className={`relative ${className || ""}`}>
      {/* Virtual container with total height */}
      <div
        ref={virtualContainerRef}
        className="relative"
        // Inline, not applied by an effect. The scroll container's
        // scrollHeight comes from this box; setting it after paint meant every
        // first frame was 0px tall, so a restored scroll offset had nothing to
        // scroll into and the grid could only jump into place a frame later.
        style={{ height: `${totalHeight}px` }}
      >
        {/* Render only visible tiles, absolutely positioned. */}
        {visibleTiles.map((tile) => {
          const entering = tile.index >= entranceFrom;
          return (
            <div
              key={tile.item._id}
              className="absolute"
              style={{
                // No `will-change: transform` here. It used to sit on every
                // visible tile permanently, promoting each one to its own
                // compositor layer, a real memory cost on a dense grid, for an
                // element whose transform is set once and never animated.
                transform: `translate(${tile.x}px, ${tile.y}px)`,
                width: `${tile.w}px`,
                height: `${tile.h}px`,
              }}
            >
              {/* The entrance animation lives on an inner element, and the
                  position on the outer one. They cannot share: `fade-in`
                  animates `transform`, and an animated property outranks an
                  inline style for as long as it runs; with `fill-mode: both`,
                  that includes the whole stagger delay. Putting both on one
                  div meant every entering tile rendered at the origin until
                  its animation ended, so the grid opened as a pile of
                  thumbnails on top of each other that snapped into place a
                  quarter-second later. On mount `entranceFrom` is 0, so that
                  was every tile on screen, on every reload and every return
                  from the image view. */}
              <div
                className={
                  entering ? "h-full w-full motion-safe:animate-fade-in" : "h-full w-full"
                }
                style={{
                  animationDelay: entering
                    ? `${Math.min(
                        MAX_STAGGER_MS,
                        (tile.index - entranceFrom) * STAGGER_STEP_MS
                      )}ms`
                    : undefined,
                }}
              >
                <ThumbnailTile
                  item={tile.item}
                  index={tile.index}
                  selected={selectionMode && selection.has(tile.item._id)}
                  selectionMode={selectionMode}
                  dimQuarantined={dimQuarantined}
                  onOpen={onOpen}
                  onToggle={onToggle}
                  getRoot={resolveScroller}
                  eager
                  peekQuery={peekQuery}
                  focused={tile.index === focusedIndex}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
