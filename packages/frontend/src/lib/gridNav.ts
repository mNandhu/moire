// Keyboard focus navigation for the gallery grid. Pure so the index math is
// unit-testable without a DOM. Left/Right step by one; Up/Down step by a row
// (cols). Movement clamps at the ends (it never wraps) and from "no focus"
// (-1) any arrow lands on the first tile.

export type GridNavKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown";

/**
 * Next focus index for an arrow key. `current` is -1 when nothing is focused.
 * `cols` is the current column count, `count` the number of tiles. Returns the
 * clamped target index (always within [0, count-1] when count > 0).
 */
export function nextFocusIndex(
  current: number,
  key: GridNavKey,
  cols: number,
  count: number,
): number {
  if (count <= 0) return -1;
  const c = Math.max(1, cols);
  if (current < 0) return 0; // first arrow focuses the first tile

  let next = current;
  if (key === "ArrowLeft") next = current - 1;
  else if (key === "ArrowRight") next = current + 1;
  else if (key === "ArrowUp") next = current - c;
  else if (key === "ArrowDown") next = current + c;

  // Clamp; vertical moves that fall off the end stay put rather than jumping.
  if (next < 0 || next >= count) return current;
  return next;
}
