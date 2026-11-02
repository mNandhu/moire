import { describe, expect, it } from "vitest";
import { pickNearest, spanGap } from "./loadOrder";

const view = { top: 1000, bottom: 1600 };

describe("spanGap", () => {
  it("is 0 when spans overlap or touch", () => {
    expect(spanGap({ top: 900, bottom: 1100 }, view)).toBe(0);
    expect(spanGap({ top: 1600, bottom: 1700 }, view)).toBe(0);
  });
  it("measures the gap above and below", () => {
    expect(spanGap({ top: 100, bottom: 300 }, view)).toBe(700);
    expect(spanGap({ top: 2000, bottom: 2100 }, view)).toBe(400);
  });
});

describe("pickNearest", () => {
  it("returns -1 for an empty list", () => {
    expect(pickNearest([], view)).toBe(-1);
  });
  it("picks the nearest, not the oldest", () => {
    const spans = [
      { top: 0, bottom: 200 },
      { top: 2400, bottom: 2600 },
      { top: 1700, bottom: 1900 },
    ];
    expect(pickNearest(spans, view)).toBe(2);
  });
  it("breaks ties by earliest index", () => {
    const spans = [
      { top: 1200, bottom: 1300 },
      { top: 1000, bottom: 1100 },
    ];
    expect(pickNearest(spans, view)).toBe(0);
  });
  it("serves a waiter with no span at once", () => {
    const spans = [{ top: 1700, bottom: 1900 }, null, undefined];
    expect(pickNearest(spans, view)).toBe(1);
  });
  it("falls back to FIFO without a viewport", () => {
    const spans = [
      { top: 5000, bottom: 5100 },
      { top: 1000, bottom: 1100 },
    ];
    expect(pickNearest(spans, null)).toBe(0);
  });
});
