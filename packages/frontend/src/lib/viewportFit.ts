/** Edges of a box, as `getBoundingClientRect` gives them. */
export type Edges = { left: number; top: number; right: number; bottom: number };

/**
 * How far to shift a popover so it sits inside the viewport, `margin` px
 * clear of each edge. Zero on an axis where it already fits. When it is
 * larger than the viewport the left / top edge wins: a menu cut off at the
 * bottom still shows its first items.
 */
export function nudgeIntoView(
  box: Edges,
  width: number,
  height: number,
  margin = 8,
): { x: number; y: number } {
  const axis = (start: number, end: number, size: number) => {
    let d = 0;
    if (end > size - margin) d = size - margin - end;
    if (start + d < margin) d = margin - start;
    return d;
  };
  return {
    x: axis(box.left, box.right, width),
    y: axis(box.top, box.bottom, height),
  };
}
