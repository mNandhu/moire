import { describe, it, expect } from "vitest";
import {
  clampDensity,
  gridColumns,
  PHONE_DEFAULT_DENSITY,
  targetTileWidth,
  DENSITY_STEPS,
  MIN_COLUMNS,
  MAX_COLUMNS,
  columnWidth,
  gapForDensity,
  aspectHeight,
  estimateItemHeight,
  lowerBoundByBottom,
  packColumns,
  visibleSlice,
  LOAD_AHEAD_PX,
  SCROLL_STEP_PX,
  scrollStep,
  OVERSCAN_PX,
} from "./masonryLayout";

describe("gridColumns", () => {
  it("gives a phone one more column per zoom step, down to a thumb's width", () => {
    const counts = DENSITY_STEPS.map((_, d) => gridColumns(343, d));
    expect(counts).toEqual([1, 2, 3, 4, 5]);
    expect(gridColumns(343, PHONE_DEFAULT_DENSITY)).toBe(2);
  });

  it("never makes phone tiles narrower than a thumb", () => {
    expect(gridColumns(200, DENSITY_STEPS.length - 1)).toBe(3);
    // Gutters count: two 56px tiles and an 8px gap need 120px.
    expect(gridColumns(120, DENSITY_STEPS.length - 1)).toBe(2);
    expect(gridColumns(119, DENSITY_STEPS.length - 1)).toBe(1);
  });

  it("derives columns from the target tile width", () => {
    // DEFAULT_DENSITY targets 250px tiles.
    expect(gridColumns(1000)).toBe(4);
    expect(gridColumns(1500)).toBe(6);
    expect(gridColumns(2000)).toBe(8);
  });

  it("packs more columns as density increases", () => {
    const coarse = gridColumns(1600, 0);
    const dense = gridColumns(1600, DENSITY_STEPS.length - 1);
    expect(dense).toBeGreaterThan(coarse);
    expect(coarse).toBe(3); // 1600 / 460
    expect(dense).toBe(11); // 1600 / 140
  });

  it("never returns zero columns for a narrow or unmeasured container", () => {
    expect(gridColumns(0)).toBe(MIN_COLUMNS);
    expect(gridColumns(-10)).toBe(MIN_COLUMNS);
    expect(gridColumns(80, DENSITY_STEPS.length - 1)).toBe(MIN_COLUMNS);
  });

  it("caps columns so an ultrawide display stays legible", () => {
    expect(gridColumns(100_000, DENSITY_STEPS.length - 1)).toBe(MAX_COLUMNS);
  });

  it("clamps out-of-range density indices instead of returning NaN", () => {
    expect(targetTileWidth(-5)).toBe(DENSITY_STEPS[0]);
    expect(targetTileWidth(99)).toBe(DENSITY_STEPS[DENSITY_STEPS.length - 1]);
  });

  it("clampDensity rounds to a step and clamps to the ends", () => {
    expect(clampDensity(1.4)).toBe(1);
    expect(clampDensity(-3)).toBe(0);
    expect(clampDensity(99)).toBe(DENSITY_STEPS.length - 1);
  });
});

describe("column count as keyboard navigation sees it", () => {
  // The gallery's arrow keys step a row by asking gridColumns for the column
  // count. It has to be the same question the grid packs with: same width,
  // same density, or Up/Down jumps by the wrong number of tiles. This broke
  // once already, when the grid derived columns from density and the keyboard
  // handler was still calling gridColumns with the default.
  it("agrees with the packing at every density", () => {
    const width = 1600;
    for (let d = 0; d < DENSITY_STEPS.length; d++) {
      const cols = gridColumns(width, d);
      const packing = packColumns(
        Array.from({ length: 40 }, () => ({ width: 100, height: 100 })),
        cols,
        columnWidth(width, cols, gapForDensity(d)),
        gapForDensity(d),
      );
      expect(packing.columns).toHaveLength(cols);
    }
  });

  it("returns a different count once the density changes", () => {
    // Guards against a caller that silently rides the default parameter.
    const atDefault = gridColumns(1600);
    expect(gridColumns(1600, DENSITY_STEPS.length - 1)).not.toBe(atDefault);
    expect(gridColumns(1600, 0)).not.toBe(atDefault);
  });
});

describe("gapForDensity", () => {
  it("tightens the gutter as tiles get smaller", () => {
    const gaps = DENSITY_STEPS.map((_, i) => gapForDensity(i));
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeLessThan(gaps[i - 1]);
    }
  });

  it("clamps out-of-range indices", () => {
    expect(gapForDensity(-3)).toBe(gapForDensity(0));
    expect(gapForDensity(50)).toBe(gapForDensity(DENSITY_STEPS.length - 1));
  });
});

describe("columnWidth", () => {
  it("subtracts gaps between columns", () => {
    // 1000px, 4 cols, 12px gap => (1000 - 36) / 4 = 241
    expect(columnWidth(1000, 4, 12)).toBe(241);
  });
  it("returns full width for a single column", () => {
    expect(columnWidth(1000, 1, 12)).toBe(1000);
  });
  it("guards against zero/negative columns", () => {
    expect(columnWidth(1000, 0, 12)).toBe(1000);
  });
});

describe("aspectHeight", () => {
  it("preserves aspect ratio", () => {
    expect(aspectHeight({ width: 100, height: 200 }, 50)).toBe(100);
    expect(aspectHeight({ width: 200, height: 100 }, 50)).toBe(25);
  });
  it("falls back to square when dims are missing", () => {
    expect(aspectHeight({}, 80)).toBe(80);
  });
});

describe("estimateItemHeight", () => {
  it("floors at the minimum height", () => {
    expect(estimateItemHeight({ width: 1000, height: 10 }, 100)).toBe(150);
  });
  it("uses aspect height when above the minimum", () => {
    expect(estimateItemHeight({ width: 100, height: 300 }, 100)).toBe(300);
  });
});

// --- Packing + windowing ------------------------------------------------------
//
// This is the algorithm the gallery runs on every library. It lived inside the
// component, where "does a 3-column pack put item 4 under item 1" needed jsdom,
// a ResizeObserver stub and a fake scroll container.

// 100x200 at colWidth 100 gives a 200px tile, comfortably above
// estimateItemHeight's 150px floor, so packed geometry is exact.
const tall = (n: number) =>
  Array.from({ length: n }, () => ({ width: 100, height: 200 }));

describe("packColumns", () => {
  it("fills columns left to right before wrapping", () => {
    const p = packColumns(tall(3), 3, 100, 10);
    expect(p.tiles.map((t) => t.x)).toEqual([0, 110, 220]);
    expect(p.tiles.map((t) => t.y)).toEqual([0, 0, 0]);
  });

  it("puts the 4th item under the 1st in a 3-column grid", () => {
    const p = packColumns(tall(4), 3, 100, 10);
    const fourth = p.tiles[3];
    expect(fourth.x).toBe(0);
    expect(fourth.y).toBe(210); // 200 tall + 10 gap
  });

  it("sends each item to the shortest column, ties going left", () => {
    // A tall first item must push the next items into the other columns, and
    // the 4th back into a short one rather than under the tall one.
    const items = [
      { width: 100, height: 800 },
      { width: 100, height: 200 },
      { width: 100, height: 200 },
      { width: 100, height: 200 },
    ];
    const p = packColumns(items, 3, 100, 10);
    expect(p.tiles.map((t) => t.x)).toEqual([0, 110, 220, 110]);
  });

  it("totalHeight is the tallest column, not the sum", () => {
    // Summing would over-scroll the grid by a factor of `cols`.
    const p = packColumns(tall(3), 3, 100, 10);
    expect(p.totalHeight).toBe(210);
  });

  it("groups tiles by column, each sorted by ascending y", () => {
    const p = packColumns(tall(6), 2, 100, 10);
    expect(p.columns).toHaveLength(2);
    for (const col of p.columns) {
      const ys = col.map((t) => t.y);
      expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    }
  });

  it("keeps the original item index on every tile", () => {
    const p = packColumns(tall(5), 2, 100, 10);
    expect(p.tiles.map((t) => t.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("is empty for a zero column count or width", () => {
    expect(packColumns(tall(3), 0, 100, 10).tiles).toEqual([]);
    expect(packColumns(tall(3), 3, 0, 10).totalHeight).toBe(0);
    expect(packColumns([], 3, 100, 10).totalHeight).toBe(0);
  });
});

describe("lowerBoundByBottom", () => {
  const column = packColumns(tall(5), 1, 100, 10).columns[0];

  it("returns 0 when the window starts above everything", () => {
    expect(lowerBoundByBottom(column, 0)).toBe(0);
  });

  it("includes a tile straddling the window's top edge", () => {
    // Tile 1 spans y 210..410. A window starting at 250 cuts through it, so it
    // is partly on screen and must be included, not skipped.
    expect(lowerBoundByBottom(column, 250)).toBe(1);
  });

  it("keeps a tile whose bottom lands exactly on the window top", () => {
    // Tile 0 spans 0..200. The bound is inclusive on the bottom edge, so a
    // window starting at 200 still keeps it; one past that drops it.
    expect(lowerBoundByBottom(column, 200)).toBe(0);
    expect(lowerBoundByBottom(column, 201)).toBe(1);
  });

  it("returns the length when the window starts below everything", () => {
    expect(lowerBoundByBottom(column, 99999)).toBe(column.length);
  });

  it("agrees with a linear scan at every boundary", () => {
    for (let y = 0; y < 600; y += 7) {
      const linear = column.findIndex((t) => t.y + t.h >= y);
      expect(lowerBoundByBottom(column, y)).toBe(
        linear === -1 ? column.length : linear,
      );
    }
  });
});

describe("visibleSlice", () => {
  const { columns } = packColumns(tall(40), 2, 100, 10);

  it("mounts only a window of the tiles, not all of them", () => {
    const out = visibleSlice(columns, 0, 500, 0);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(40);
  });

  it("includes tiles straddling both edges of the window", () => {
    const out = visibleSlice(columns, 200, 200, 0);
    const tops = out.map((t) => t.y);
    const bottoms = out.map((t) => t.y + t.h);
    expect(Math.min(...tops)).toBeLessThan(200); // straddles the top
    expect(Math.max(...bottoms)).toBeGreaterThan(400); // straddles the bottom
  });

  it("overscan widens the window on both sides", () => {
    const tight = visibleSlice(columns, 500, 200, 0);
    const loose = visibleSlice(columns, 500, 200, 300);
    expect(loose.length).toBeGreaterThan(tight.length);
  });

  it("clamps the window at the top of the grid", () => {
    const out = visibleSlice(columns, 0, 200, 1000);
    expect(out[0].y).toBe(0);
  });

  it("returns nothing past the end of the grid", () => {
    expect(visibleSlice(columns, 99999, 200, 0)).toEqual([]);
  });

  it("never drops a tile that a linear scan would keep", () => {
    for (let top = 0; top < 2000; top += 137) {
      const got = new Set(visibleSlice(columns, top, 300, 100).map((t) => t.index));
      const startY = Math.max(0, top - 100);
      const endY = top + 300 + 100;
      const expected = columns
        .flat()
        .filter((t) => t.y + t.h >= startY && t.y <= endY)
        .map((t) => t.index);
      for (const i of expected) expect(got.has(i)).toBe(true);
    }
  });
});

describe("load-ahead constants", () => {
  it("the grid mounts tiles before they start loading", () => {
    // These were two unrelated literals in two files; the ordering is the whole
    // point of the pairing.
    expect(OVERSCAN_PX).toBeGreaterThan(LOAD_AHEAD_PX);
  });
});

describe("scrollStep", () => {
  it("snaps down to a step that the mount window can absorb", () => {
    expect(scrollStep(0)).toBe(0);
    expect(scrollStep(SCROLL_STEP_PX - 1)).toBe(0);
    expect(scrollStep(SCROLL_STEP_PX * 3 + 5)).toBe(SCROLL_STEP_PX * 3);
    // Tiles must still mount before they start loading their image.
    expect(SCROLL_STEP_PX).toBeLessThan(OVERSCAN_PX - LOAD_AHEAD_PX);
  });
});
