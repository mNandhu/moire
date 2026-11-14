import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { StepItem } from "@/lib/stepList";
import { smallThumb } from "@/lib/media";
import { imageFileName } from "@/features/ai/lib/ai";
import { centreOf, stripWindow, tileLeft, type StripMetrics } from "@/features/images/lib/filmstrip";

/** Strip height (the thumbnails' box), and how much room the stage gives it. */
const TILE_H = 52;
export const FILMSTRIP_ROOM = 76;
// Tiles rendered either side of the current one; the rest of the feed is not
// in the DOM, so a long feed costs nothing.
const REACH = 40;
// Pixels a press has to travel before it is a scrub rather than a click.
const DRAG_SLOP = 4;
// A wheel scrub ends this long after its last tick.
const WHEEL_IDLE_MS = 180;
// Ask for the next feed page this many tiles before the loaded end.
const PAGE_AHEAD = 15;
// WheelEvent deltas in lines (Firefox on some setups) to pixels.
const LINE_PX = 16;

// Equal portrait frames.
const METRICS: StripMetrics = { tile: 38, gap: 6 };
const STEP = METRICS.tile + METRICS.gap;

/**
 * The gallery feed as a strip of thumbnails under the open image, centred on
 * it. Click a thumbnail to open it; drag or scroll the wheel across the strip
 * to scrub through the feed. Only the strip moves while scrubbing: the image
 * it stops on opens when the drag or the wheel ends, so a scrub across many
 * tiles doesn't load every original it passes. Pages the feed in as the scrub
 * nears the end of what is loaded.
 */
export function FilmStrip({
  items,
  index,
  onPick,
  loadMore,
}: {
  items: readonly StepItem[];
  index: number;
  onPick: (id: string) => void;
  /** Fetches the next feed page if there is one and none is on its way. */
  loadMore: () => void;
}) {
  // Fractional place in the list while scrubbing; null at rest.
  const [scrub, setScrub] = useState<number | null>(null);
  // The same, read by event handlers that fire faster than renders (wheel ticks).
  const scrubRef = useRef<number | null>(null);
  // Where a scrub ended, held until the route arrives there, so the strip
  // doesn't swing back to the old image in between.
  const [target, setTarget] = useState<number | null>(null);
  useEffect(() => {
    setTarget(null);
  }, [index]);
  const pos = scrub ?? target ?? index;
  const drag = useRef<{ x: number; from: number; moved: boolean; pointer: number } | null>(null);
  const suppressClick = useRef(false);
  const wheelTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(wheelTimer.current), []);

  useEffect(() => {
    if (Math.round(pos) >= items.length - PAGE_AHEAD) loadMore();
  }, [pos, items.length, loadMore]);

  const scrubTo = (p: number) => {
    const clamped = Math.min(items.length - 1, Math.max(0, p));
    scrubRef.current = clamped;
    setScrub(clamped);
  };
  const endScrub = () => {
    const p = scrubRef.current;
    scrubRef.current = null;
    setScrub(null);
    if (p === null) return;
    const n = Math.round(p);
    if (n === index || !items[n]) return;
    setTarget(n);
    onPick(items[n]._id);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    suppressClick.current = false;
    drag.current = { x: e.clientX, from: Math.round(pos), moved: false, pointer: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    // Dragging the strip left moves on through the feed, as on a phone.
    scrubTo(d.from - dx / STEP);
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (d.moved) {
      suppressClick.current = true;
      endScrub();
    }
  };

  // The wheel is bound natively, not through React (whose wheel listener is
  // passive), so it can take the event: a horizontal two-finger swipe over the
  // strip would otherwise also start the browser's back gesture.
  const stripRef = useRef<HTMLDivElement>(null);
  const onWheel = (e: WheelEvent) => {
    let delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    e.preventDefault();
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= LINE_PX;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= stripRef.current?.clientWidth ?? 400;
    scrubTo((scrubRef.current ?? Math.round(pos)) + delta / STEP / 2);
    window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(endScrub, WHEEL_IDLE_MS);
  };
  const wheelRef = useRef(onWheel);
  useEffect(() => {
    wheelRef.current = onWheel;
  });
  const visible = index >= 0 && items.length > 0;
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const listener = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, [visible]);

  if (!visible) return null;
  // The ring follows the scrub, so it marks the image that opens on release.
  const marked = Math.round(pos);
  const [lo, hi] = stripWindow(pos, items.length, REACH);
  const tiles = [];
  for (let i = lo; i <= hi; i++) {
    const it = items[i];
    const here = i === marked;
    tiles.push(
      <button
        key={it._id}
        type="button"
        onClick={() => onPick(it._id)}
        aria-label={imageFileName(it._id)}
        aria-current={i === index ? "true" : undefined}
        className={`absolute top-0 h-full overflow-hidden rounded-md bg-raised transition-opacity duration-200 ${
          here ? "opacity-100" : "opacity-55 hover:opacity-90"
        }`}
        style={{ left: tileLeft(i, METRICS), width: METRICS.tile }}
      >
        {it.thumb_url && (
          <img
            src={smallThumb(it.thumb_url)}
            alt=""
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover"
          />
        )}
        {here && <span className="absolute inset-0 rounded-md ring-2 ring-inset ring-brand-400" />}
      </button>,
    );
  }

  return (
    <div
      ref={stripRef}
      role="navigation"
      aria-label="Filmstrip"
      className="relative w-full touch-none select-none overflow-hidden overscroll-x-contain"
      style={{
        height: TILE_H,
        maskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={(e) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.stopPropagation();
      }}
      // The stage steps on a swipe; a drag along the strip is a scrub instead.
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      <div
        className="absolute inset-y-0 left-1/2"
        style={{
          transform: `translateX(${-centreOf(pos, METRICS)}px)`,
          transition: scrub === null ? "transform 250ms ease-out" : "none",
        }}
      >
        {tiles}
      </div>
    </div>
  );
}
