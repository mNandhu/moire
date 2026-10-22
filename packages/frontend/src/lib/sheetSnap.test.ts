import { describe, expect, it } from "vitest";
import { snapSheet } from "./sheetSnap";

const STOPS = [0, 400, 800]; // full, peek, closed

describe("snapSheet", () => {
  it("settles a slow drag on the nearest stop", () => {
    expect(snapSheet(150, 0, STOPS)).toBe(0);
    expect(snapSheet(350, 0, STOPS)).toBe(1);
    expect(snapSheet(700, 0, STOPS)).toBe(2);
  });

  it("carries a flick on to the next stop", () => {
    // Barely moved from peek, flung up: full.
    expect(snapSheet(380, -1.5, STOPS)).toBe(0);
    // Barely moved from peek, flung down: closed.
    expect(snapSheet(420, 1.5, STOPS)).toBe(2);
  });

  it("never picks past the last stop", () => {
    expect(snapSheet(790, 5, STOPS)).toBe(2);
    expect(snapSheet(5, -5, STOPS)).toBe(0);
  });
});
