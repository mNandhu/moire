import { describe, expect, it } from "vitest";
import { countHint, countLabel, fixedSeeds, splitRequests } from "./requests";

describe("splitRequests", () => {
  it("matches the backend split", () => {
    expect(splitRequests(8, 2)).toEqual([2, 2, 2, 2]);
    expect(splitRequests(7, 3)).toEqual([3, 3, 1]);
    expect(splitRequests(3, null)).toEqual([null, null, null]);
    expect(splitRequests(0, 2)).toEqual([]);
  });
});

describe("countLabel", () => {
  it("covers the three count modes", () => {
    expect(countLabel(8, { kind: "images", perRequest: 2 })).toBe("4 runs of 2");
    expect(countLabel(2, { kind: "images", perRequest: 2 })).toBe("1 run of 2");
    expect(countLabel(1, { kind: "images", perRequest: 2 })).toBe("1 run of 1");
    expect(countLabel(7, { kind: "images", perRequest: 3 })).toBe("3 runs of up to 3");
    expect(countLabel(4, { kind: "images", perRequest: 1 })).toBe("4 runs");
    expect(countHint(7, { kind: "images", perRequest: 3 })).toBe(
      "7 images in total. ComfyUI makes up to 3 at a time (the batch size), so this is 3 runs: 3, 3, 1.",
    );
    expect(countLabel(8, { kind: "requests", literal: 4 })).toBe("8 × 4 = 32 images");
    expect(countLabel(8, { kind: "unknown" })).toBe("8 × ?");
  });
});

it("fixed seeds count up per request", () => {
  expect(fixedSeeds(100, 3)).toEqual([100, 101, 102]);
});
