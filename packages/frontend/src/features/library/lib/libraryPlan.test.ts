import { describe, expect, it } from "vitest";
import {
  defaultSelected,
  formatCount,
  isSelectable,
  parsePathList,
  type LibraryCandidate,
} from "./libraryPlan";

const cand = (over: Partial<LibraryCandidate> = {}): LibraryCandidate => ({
  path: "/x/a",
  name: "a",
  source: "/x",
  image_count: 3,
  count_capped: false,
  hidden: false,
  status: "new",
  note: null,
  conflict_path: null,
  ...over,
});

describe("parsePathList", () => {
  it("splits lines and semicolons, trims, drops blanks and repeats", () => {
    expect(parsePathList(" /a \n\n/b;/a\r\n D:/imgs ")).toEqual(["/a", "/b", "D:/imgs"]);
  });
});

describe("candidate defaults", () => {
  it("ticks new folders only", () => {
    expect(defaultSelected(cand())).toBe(true);
    expect(defaultSelected(cand({ hidden: true }))).toBe(false);
    expect(defaultSelected(cand({ status: "empty" }))).toBe(false);
    expect(defaultSelected(cand({ status: "overlap" }))).toBe(false);
  });

  it("never lets an already-registered folder be added", () => {
    expect(isSelectable(cand({ status: "registered" }))).toBe(false);
    expect(isSelectable(cand({ status: "overlap" }))).toBe(true);
  });
});

describe("formatCount", () => {
  it("pluralizes and marks a capped count as a lower bound", () => {
    expect(formatCount({ image_count: 1, count_capped: false })).toBe("1 image");
    expect(formatCount({ image_count: 5000, count_capped: true })).toBe("5,000+ images");
    expect(formatCount({ image_count: 0, count_capped: true })).toBe("not counted");
  });
});
