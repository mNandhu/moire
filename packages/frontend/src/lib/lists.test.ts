import { describe, expect, it } from "vitest";
import { addPieces, sameList } from "./lists";

describe("sameList", () => {
  it("compares items in order", () => {
    expect(sameList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameList(["a"], ["a", "b"])).toBe(false);
    expect(sameList([], [])).toBe(true);
  });
});

describe("addPieces", () => {
  const lower = (p: string) => p.trim().toLowerCase() || null;

  it("appends each comma piece and skips blanks", () => {
    expect(addPieces(["a"], " B , ,c", lower)).toEqual(["a", "b", "c"]);
  });

  it("skips pieces already present or repeated within the text", () => {
    expect(addPieces(["a"], "a, b, b", lower)).toEqual(["a", "b"]);
  });

  it("dedupes on keyOf while keeping the entry as written", () => {
    const key = (e: string) => e.replace(/[\s_]+/g, "_");
    expect(addPieces(["best_quality"], "best quality, score 9", lower, key)).toEqual(["best_quality", "score 9"]);
  });

  it("lets toEntry reject a piece", () => {
    const noStars = (p: string) => (p.trim().replace(/\*/g, "") ? p.trim() : null);
    expect(addPieces([], "*, a*", noStars)).toEqual(["a*"]);
  });
});
