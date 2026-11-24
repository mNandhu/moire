import { describe, expect, it } from "vitest";
import { heldPick, pickOne, rareTags, sample } from "./discover";

// A fixed sequence, so a pick is the same every run.
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};

describe("sample", () => {
  it("picks distinct items, all of a short list", () => {
    const got = sample([1, 2, 3, 4, 5], 3, seq(0.5, 0, 0.99));
    expect(got).toEqual([3, 1, 5]);
    expect(sample([1, 2], 5).sort()).toEqual([1, 2]);
    expect(pickOne([], Math.random)).toBeUndefined();
  });
});

describe("rareTags", () => {
  const tags = Array.from({ length: 100 }, (_, i) => ({ tag: `t${i}`, count: i }));

  it("takes from the rarest quarter, never single-image tags, rarest first", () => {
    const got = rareTags(tags, 10, seq(0.3, 0.7, 0.1, 0.9, 0.5));
    expect(got).toHaveLength(10);
    expect(got.every((t) => t.count >= 2 && t.count < 2 + 25)).toBe(true);
    expect(got.map((t) => t.count)).toEqual([...got.map((t) => t.count)].sort((a, b) => a - b));
  });

  it("keeps a pool of at least 24 in a small library", () => {
    const few = tags.slice(0, 30);
    const got = rareTags(few, 30, Math.random);
    expect(got).toHaveLength(24);
  });
});

describe("heldPick", () => {
  it("picks once per deal, whatever the data does after", () => {
    const store = new Map();
    let calls = 0;
    const pick = (d: number[]) => {
      calls++;
      return d[0];
    };
    expect(heldPick(store, "x", 0, undefined, pick)).toBeUndefined();
    expect(heldPick(store, "x", 0, [1], pick)).toBe(1);
    expect(heldPick(store, "x", 0, [2], pick)).toBe(1); // a refetch
    expect(heldPick(store, "x", 1, [2], pick)).toBe(2); // a new deal
    expect(calls).toBe(2);
  });
});
