// Masonry layout math for the virtualized gallery: how many columns to show at
// a given density, how tall each tile packs, and which tiles a viewport needs
// mounted. Pure functions: the arithmetic that decides whether the grid shows
// a blank band while scrolling belongs somewhere a test can reach.

export type Dims = { width?: number; height?: number };

/**
 * Gallery density, as the target on-screen width of one tile in px. Columns are
 * derived from it rather than from fixed breakpoints, so a wide display packs
 * more tiles instead of stretching four of them across 2000px.
 *
 * Ordered coarse -> dense; the index is what gets persisted (see useDensity),
 * because the px values are a tuning detail that should be free to change
 * without invalidating everyone's stored preference.
 */
export const DENSITY_STEPS = [460, 340, 250, 185, 140] as const;

/** Index into DENSITY_STEPS used when nothing is stored. */
export const DEFAULT_DENSITY = 2;

/** Hard bounds on the derived column count. */
export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 14;

/** Target tile width for a density index, clamped to the available steps. */
export function targetTileWidth(density: number): number {
  const i = Math.max(0, Math.min(DENSITY_STEPS.length - 1, Math.round(density)));
  return DENSITY_STEPS[i];
}

/**
 * Column count for a container width at a given density.
 *
 * This is the single source of truth for "how many columns is the gallery
 * showing". The grid packs with it and the keyboard navigation steps rows by
 * it. They used to disagree: the CSS grid used viewport-based Tailwind
 * breakpoints (which could yield 1 column) while this returned 2/3/4 from the
 * container width, so arrow-key row jumps were wrong at narrow widths.
 */
export function gridColumns(
  containerWidth: number,
  density: number = DEFAULT_DENSITY,
): number {
  if (containerWidth <= 0) return MIN_COLUMNS;
  const target = targetTileWidth(density);
  const cols = Math.round(containerWidth / target);
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, cols));
}

/**
 * Gutter between tiles at a given density. Tight grids want tight gutters: a
 * fixed 12px gap that looks right around 250px tiles reads as a chasm at 140px
 * and as a cramped seam at 460px.
 */
export function gapForDensity(density: number): number {
  const i = Math.max(0, Math.min(DENSITY_STEPS.length - 1, Math.round(density)));
  return [16, 14, 12, 10, 8][i];
}

/** Width of one column given the container width, column count, and gap. */
export function columnWidth(
  containerWidth: number,
  cols: number,
  gap: number,
): number {
  if (cols <= 0) return containerWidth;
  return (containerWidth - gap * (cols - 1)) / cols;
}

/**
 * Rendered pixel height of an item at a given column width, preserving its
 * aspect ratio. Missing dimensions fall back to square (1×1).
 */
export function aspectHeight(item: Dims, colWidth: number): number {
  const w = item.width || 1;
  const h = item.height || 1;
  return (h / w) * colWidth;
}

/**
 * Estimated row height for virtualization: the aspect height, floored at a
 * minimum so unmeasured items still reserve space.
 */
export function estimateItemHeight(
  item: Dims,
  colWidth: number,
  minHeight = 150,
): number {
  return Math.max(minHeight, aspectHeight(item, colWidth));
}


/**
 * How far ahead of the viewport a tile starts loading its image
 * (ImageThumbnail's IntersectionObserver rootMargin).
 */
export const LOAD_AHEAD_PX = 1200;

/**
 * How far ahead of the viewport the virtualized grid mounts tiles.
 *
 * Must exceed LOAD_AHEAD_PX so a tile is mounted before it wants to load;
 * otherwise the load-ahead window is clipped by the mount window and thumbs
 * only start fetching once they are nearly on screen. These were two unrelated
 * literals in two files whose ordering was described in a pair of comments and
 * enforced by nothing.
 */
export const OVERSCAN_PX = LOAD_AHEAD_PX + 400;

/** One positioned tile in the masonry layout (pixel coords within the wrapper). */
export type PackedTile<T> = {
  item: T;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Packing<T> = {
  /** Every tile, in item order. */
  tiles: PackedTile<T>[];
  /** Tiles grouped by column, each sorted by ascending y. */
  columns: PackedTile<T>[][];
  /** Height of the tallest column: the scrollable height of the grid. */
  totalHeight: number;
};

/**
 * Column-masonry packing: each item goes in the currently-shortest column
 * (ties go left), so short items pack up and tiles below rise to fill gaps
 * rather than leaving space under the short items in a tall row.
 *
 * `totalHeight` is the tallest column, not the sum, getting that wrong
 * over-scrolls the grid by a factor of `cols`.
 */
export function packColumns<T extends Dims>(
  items: T[],
  cols: number,
  colWidth: number,
  gap: number,
): Packing<T> {
  if (cols <= 0 || colWidth <= 0) {
    return { tiles: [], columns: [], totalHeight: 0 };
  }

  const colHeights: number[] = new Array(cols).fill(0);
  const columns: PackedTile<T>[][] = Array.from({ length: cols }, () => []);
  const tiles: PackedTile<T>[] = [];

  for (let i = 0; i < items.length; i++) {
    let col = 0;
    for (let c = 1; c < cols; c++) {
      if (colHeights[c] < colHeights[col]) col = c;
    }
    const h = estimateItemHeight(items[i], colWidth);
    const tile: PackedTile<T> = {
      item: items[i],
      index: i,
      x: col * (colWidth + gap),
      y: colHeights[col],
      w: colWidth,
      h,
    };
    colHeights[col] += h + gap;
    columns[col].push(tile);
    tiles.push(tile);
  }

  return { tiles, columns, totalHeight: Math.max(0, ...colHeights) };
}

/**
 * Index of the first tile in a column whose *bottom* reaches y. Columns are
 * sorted by ascending y and tiles don't overlap, so the predicate is monotonic
 * and a binary search is valid.
 *
 * A tile straddling y must be included: it is partly on screen. That is the
 * `<` rather than `<=` on the bottom edge.
 */
export function lowerBoundByBottom<T>(
  column: PackedTile<T>[],
  y: number,
): number {
  let lo = 0;
  let hi = column.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (column[mid].y + column[mid].h < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The tiles to mount for a viewport window, expanded by `overscan` on both
 * sides. Walks each column from the first tile reaching into the window and
 * stops once a tile starts past it (everything below starts lower still).
 *
 * An off-by-one here shows up as an intermittent blank band while scrolling:
 * the worst feedback loop available, which is why it belongs somewhere a test
 * can reach.
 */
export function visibleSlice<T>(
  columns: PackedTile<T>[][],
  viewportTop: number,
  viewportHeight: number,
  overscan: number = OVERSCAN_PX,
): PackedTile<T>[] {
  const startY = Math.max(0, viewportTop - overscan);
  const endY = viewportTop + viewportHeight + overscan;

  const out: PackedTile<T>[] = [];
  for (const column of columns) {
    for (let i = lowerBoundByBottom(column, startY); i < column.length; i++) {
      if (column[i].y > endY) break;
      out.push(column[i]);
    }
  }
  return out;
}
