import { describe, expect, it } from "vitest";
import { nudgeIntoView } from "./viewportFit";

const box = (left: number, top: number, w: number, h: number) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

describe("nudgeIntoView", () => {
  it("leaves a box that fits alone", () => {
    expect(nudgeIntoView(box(20, 20, 200, 200), 375, 812)).toEqual({ x: 0, y: 0 });
  });

  it("pulls a box past the left edge back in", () => {
    expect(nudgeIntoView(box(-248, 100, 256, 200), 375, 812).x).toBe(256);
  });

  it("pulls a box past the right edge back in", () => {
    expect(nudgeIntoView(box(200, 100, 256, 200), 375, 812).x).toBe(-89);
  });

  it("lifts a box that runs off the bottom", () => {
    expect(nudgeIntoView(box(20, 700, 180, 220), 375, 812).y).toBe(-116);
  });

  it("keeps the start edge when the box is wider than the viewport", () => {
    expect(nudgeIntoView(box(-40, 10, 400, 100), 375, 812).x).toBe(48);
  });

  it("keeps the top when the box is taller than the viewport", () => {
    expect(nudgeIntoView(box(10, 300, 100, 900), 375, 812).y).toBe(-292);
  });
});
