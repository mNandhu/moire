// Which queued thumbnail gets the next free load slot. Pure, so the choice is
// testable without a DOM. The grid already knows every tile's top and bottom in
// scroll-content coordinates and the scroll position, so distance is plain
// arithmetic on those: no IntersectionObserver (eager tiles have none) and no
// layout read per queued tile.

/** A vertical extent in scroll-content px. */
export type Span = { top: number; bottom: number };

/** Gap between two spans; 0 when they overlap or touch. */
export function spanGap(a: Span, b: Span): number {
  if (a.bottom < b.top) return b.top - a.bottom;
  if (b.bottom < a.top) return a.top - b.bottom;
  return 0;
}

/**
 * Index of the waiter nearest the viewport. A waiter with no span counts as
 * distance 0, so it is never starved behind tiles that have one. Ties, and
 * every case where no viewport is known, resolve to the earliest index (FIFO).
 * Returns -1 for an empty list.
 */
export function pickNearest(
  spans: ReadonlyArray<Span | null | undefined>,
  view: Span | null,
): number {
  if (spans.length === 0) return -1;
  if (!view) return 0;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const d = s ? spanGap(s, view) : 0;
    if (d < bestDist) {
      best = i;
      bestDist = d;
      if (d === 0) break;
    }
  }
  return best;
}
