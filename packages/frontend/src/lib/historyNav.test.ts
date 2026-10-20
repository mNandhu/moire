import { describe, expect, it } from "vitest";
import { historyIdx, nextMaxIdx } from "./historyNav";

describe("historyIdx", () => {
  it("reads react-router's idx", () => {
    expect(historyIdx({ idx: 3, key: "x" })).toBe(3);
  });
  it("is 0 without one", () => {
    expect(historyIdx(null)).toBe(0);
    expect(historyIdx({})).toBe(0);
  });
});

describe("nextMaxIdx", () => {
  it("moves with a push and drops what was ahead", () => {
    // At 2 of 4, then a push lands on 3 with nothing ahead.
    expect(nextMaxIdx(4, 3, "PUSH")).toBe(3);
  });
  it("keeps the entries ahead on a back or forward", () => {
    expect(nextMaxIdx(4, 1, "POP")).toBe(4);
    expect(nextMaxIdx(1, 2, "POP")).toBe(2);
  });
  it("keeps them on a replace too", () => {
    expect(nextMaxIdx(4, 2, "REPLACE")).toBe(4);
  });
});
