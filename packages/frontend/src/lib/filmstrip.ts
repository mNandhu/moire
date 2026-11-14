/**
 * Layout for ImageView's filmstrip: equal tiles along a track, centred on the
 * open (or scrubbed-to) image. Positions are measured from the left edge of
 * tile 0. Pure.
 */

export type StripMetrics = {
  /** Width of a tile. */
  tile: number;
  /** Space between tiles. */
  gap: number;
};

/** Left edge of tile `i`. */
export function tileLeft(i: number, m: StripMetrics): number {
  return i * (m.tile + m.gap);
}

/** The track position to centre on for a (possibly fractional, mid-scrub) place in the list. */
export function centreOf(pos: number, m: StripMetrics): number {
  return pos * (m.tile + m.gap) + m.tile / 2;
}

/** Indices to render around `pos`, `reach` either side, clamped to the list. */
export function stripWindow(pos: number, count: number, reach: number): [number, number] {
  const at = Math.round(pos);
  return [Math.max(0, at - reach), Math.min(count - 1, at + reach)];
}
