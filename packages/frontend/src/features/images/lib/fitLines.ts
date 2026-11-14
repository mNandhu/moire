/**
 * How many lines of a long text block to show so its panel fills without
 * scrolling: the whole lines that fit in what the rest of the panel leaves,
 * less room for a "Show more" toggle, and never fewer than `minLines`. Null
 * when the text fits whole (no clamp, no toggle).
 */
export function fitLines({
  available,
  lineHeight,
  fullHeight,
  toggleHeight,
  minLines = 3,
}: {
  /** Height the text may take before the panel scrolls. */
  available: number;
  lineHeight: number;
  /** The text's unclamped height. */
  fullHeight: number;
  toggleHeight: number;
  minLines?: number;
}): number | null {
  if (fullHeight <= available + 1) return null;
  const lines = Math.max(minLines, Math.floor((available - toggleHeight) / lineHeight));
  return lines * lineHeight >= fullHeight - 1 ? null : lines;
}
