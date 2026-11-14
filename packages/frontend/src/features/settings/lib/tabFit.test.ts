import { describe, expect, it } from "vitest";
import { visibleTabCount } from "./tabFit";

const base = { gap: 4, moreWidth: 80, activeIndex: 0, activeMoreWidth: 0 };

describe("visibleTabCount", () => {
  it("shows every tab when they fit, gaps included", () => {
    expect(visibleTabCount({ ...base, widths: [100, 100, 100], available: 308 })).toBe(3);
  });

  it("keeps room for More when they don't", () => {
    // 100 + 4 + 100 = 204, + 4 + 80 for More = 288 <= 300; a third won't fit.
    expect(visibleTabCount({ ...base, widths: [100, 100, 100], available: 300 })).toBe(2);
  });

  it("keeps room for a wider More naming the active moved tab", () => {
    const widths = [100, 100, 100, 100];
    const room = { ...base, widths, available: 400 };
    expect(visibleTabCount({ ...room, activeIndex: 0 })).toBe(3);
    // About (index 3) moved: More reads "About" and needs 150.
    expect(visibleTabCount({ ...room, activeIndex: 3, activeMoreWidth: 150 })).toBe(2);
    expect(visibleTabCount({ ...room, activeIndex: 3, activeMoreWidth: 200 })).toBe(1);
  });

  it("can move every tab", () => {
    expect(visibleTabCount({ ...base, widths: [100, 100], available: 90 })).toBe(0);
  });
});
