/** How many of `total` items to show so the last grid row is full: `want`
 * rounded up to a whole number of `columns`, while more are left to show.
 * All of them when rounding up would reach the end anyway. */
export function fillLastRow(want: number, columns: number, total: number): number {
  if (total <= want || columns <= 1) return Math.min(want, total);
  return Math.min(total, Math.ceil(want / columns) * columns);
}

/** The number of columns a CSS grid lays out right now. */
export function gridColumns(el: Element): number {
  const tracks = getComputedStyle(el).gridTemplateColumns;
  return tracks && tracks !== "none" ? tracks.trim().split(/\s+/).length : 1;
}
