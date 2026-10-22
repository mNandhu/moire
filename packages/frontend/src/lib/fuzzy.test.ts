import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyRank } from "./fuzzy";

describe("fuzzyScore", () => {
  it("returns 0 for an empty query (matches anything)", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "masterpiece")).toBeNull();
    expect(fuzzyScore("zzz", "abc")).toBeNull();
  });

  it("matches a subsequence out of contiguous order", () => {
    expect(fuzzyScore("mst", "masterpiece")).not.toBeNull();
  });

  it("scores exact > prefix > substring > scattered", () => {
    const exact = fuzzyScore("cat", "cat")!;
    const prefix = fuzzyScore("cat", "category")!;
    const substr = fuzzyScore("cat", "scatter")!;
    const scattered = fuzzyScore("cat", "abcart")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substr);
    expect(substr).toBeGreaterThan(scattered);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("MASTER", "masterpiece")).toEqual(
      fuzzyScore("master", "Masterpiece"),
    );
  });

  it("rewards word-boundary matches (after a colon)", () => {
    // 'foo' at the start of the segment after 'manual:' beats a mid-word hit.
    const boundary = fuzzyScore("foo", "manual:foobar")!;
    const midword = fuzzyScore("foo", "barfoobar")!;
    expect(boundary).toBeGreaterThan(midword);
  });

  it("ignores word separators the query adds or leaves out", () => {
    expect(fuzzyScore("high leg", "highleg_leotard")).not.toBeNull();
    expect(fuzzyScore("highleg", "high_leg")).not.toBeNull();
    expect(fuzzyScore("high-leg", "highleg leotard")).not.toBeNull();
    expect(fuzzyScore("high leg", "bow")).toBeNull();
    // A loose match ranks under a strict one.
    expect(fuzzyScore("high leg", "high_leg")!).toBeGreaterThan(fuzzyScore("high leg", "highleg")!);
  });
});

describe("fuzzyRank", () => {
  const tags = [
    { _id: "masterpiece", count: 1600 },
    { _id: "master", count: 12 },
    { _id: "disaster", count: 3 },
    { _id: "1girl", count: 9000 },
  ];

  it("ranks the closest match first", () => {
    const out = fuzzyRank("maste", tags, (t) => t._id);
    expect(out[0]._id).toBe("master"); // shorter exact-ish prefix wins
    expect(out.map((t) => t._id)).toContain("masterpiece");
  });

  it("drops non-matches", () => {
    const out = fuzzyRank("maste", tags, (t) => t._id);
    expect(out.map((t) => t._id)).not.toContain("1girl");
  });

  it("honours the limit", () => {
    const out = fuzzyRank("a", tags, (t) => t._id, 2);
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("keeps input order for ties (empty query)", () => {
    const out = fuzzyRank("", tags, (t) => t._id, 2);
    expect(out.map((t) => t._id)).toEqual(["masterpiece", "master"]);
  });
});
