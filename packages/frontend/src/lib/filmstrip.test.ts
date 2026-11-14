import { describe, expect, it } from "vitest";
import { centreOf, stripWindow, tileLeft, type StripMetrics } from "./filmstrip";

const m: StripMetrics = { tile: 20, gap: 4 };

describe("filmstrip layout", () => {
  it("spaces tiles evenly", () => {
    expect([0, 1, 2].map((i) => tileLeft(i, m))).toEqual([0, 24, 48]);
  });

  it("centres on a tile, and between tiles while scrubbing", () => {
    expect(centreOf(0, m)).toBe(10);
    expect(centreOf(2, m)).toBe(58);
    expect(centreOf(0.5, m)).toBe(22);
  });

  it("windows around the position, clamped to the list", () => {
    expect(stripWindow(1.4, 100, 5)).toEqual([0, 6]);
    expect(stripWindow(98, 100, 5)).toEqual([93, 99]);
  });
});
