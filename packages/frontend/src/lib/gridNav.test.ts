import { describe, it, expect } from "vitest";
import { nextFocusIndex } from "./gridNav";

describe("nextFocusIndex (cols=4, count=10)", () => {
  const C = 4;
  const N = 10;
  it("first arrow from -1 focuses index 0", () => {
    expect(nextFocusIndex(-1, "ArrowRight", C, N)).toBe(0);
    expect(nextFocusIndex(-1, "ArrowDown", C, N)).toBe(0);
  });
  it("left/right step by one", () => {
    expect(nextFocusIndex(5, "ArrowRight", C, N)).toBe(6);
    expect(nextFocusIndex(5, "ArrowLeft", C, N)).toBe(4);
  });
  it("up/down step by a row (cols)", () => {
    expect(nextFocusIndex(5, "ArrowDown", C, N)).toBe(9);
    expect(nextFocusIndex(5, "ArrowUp", C, N)).toBe(1);
  });
  it("clamps at the ends, never wraps", () => {
    expect(nextFocusIndex(0, "ArrowLeft", C, N)).toBe(0);
    expect(nextFocusIndex(9, "ArrowRight", C, N)).toBe(9);
    expect(nextFocusIndex(1, "ArrowUp", C, N)).toBe(1); // would be -3
    expect(nextFocusIndex(8, "ArrowDown", C, N)).toBe(8); // would be 12
  });
  it("empty grid yields -1", () => {
    expect(nextFocusIndex(3, "ArrowDown", C, 0)).toBe(-1);
  });
});
