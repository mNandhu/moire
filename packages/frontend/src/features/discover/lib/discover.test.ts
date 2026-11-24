import { describe, expect, it } from "vitest";
import { bannerFade, bannerPicture, faceLanding, fillUp, heldPick, pickOne, rareTags, sample } from "./discover";

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

describe("fillUp", () => {
  const img = (_id: string) => ({ _id });
  it("puts the first list first, fills from the rest, each image once", () => {
    const got = fillUp([img("a"), img("b")], [img("b"), img("c"), img("d")], 3);
    expect(got.map((x) => x._id)).toEqual(["a", "b", "c"]);
  });
  it("stops at n even within the first list", () => {
    expect(fillUp([img("a"), img("b")], [], 1).map((x) => x._id)).toEqual(["a"]);
  });
});

describe("banner fade", () => {
  it("finds where the face lands in the crop", () => {
    // Twice the frame's width, shifted half a frame left: a face mid-image
    // lands at the frame's middle.
    expect(faceLanding({ width: "200%", left: "-50%" }, { face: [0.5, 0.3, 0.1, 0.1], focus: null })).toBe(0.5);
    expect(faceLanding(null, { face: null, focus: null })).toBeNull();
  });
  it("ends before the face, within its bounds", () => {
    const stops = (g: string) => [...g.matchAll(/ (-?[\d.]+)%/g)].map((m) => parseFloat(m[1]));
    const endOf = (g: string) => stops(g)[stops(g).length - 1];
    const startOf = (g: string) => stops(g)[0];
    expect(endOf(bannerFade(0.7))).toBe(58);
    expect(endOf(bannerFade(0.95))).toBe(72);
    expect(endOf(bannerFade(0.2))).toBe(30);
    // Never begun before the image's edge, however short.
    for (const at of [0.2, 0.5, 0.7, 0.95, null]) expect(startOf(bannerFade(at))).toBeGreaterThanOrEqual(0);
    expect(startOf(bannerFade(0.95))).toBe(15);
  });
});

describe("bannerPicture", () => {
  const avatar = { thumb_image_id: "a", thumb_url: "/a", face: null, focus: null, aspect: 0.7 };
  const img = (_id: string, width: number, height: number) => ({ _id, thumb_url: `/${_id}`, width, height });
  it("prefers a landscape image over a portrait avatar without a face", () => {
    expect(bannerPicture(avatar, [img("p", 700, 1000), img("l", 1600, 900)])?.id).toBe("l");
    expect(bannerPicture(avatar, [img("p", 700, 1000)])?.id).toBe("a");
  });
  it("keeps an avatar with a face to frame, or one already wide", () => {
    const withFace = { ...avatar, face: [0.5, 0.3, 0.1, 0.1] as [number, number, number, number] };
    expect(bannerPicture(withFace, [img("l", 1600, 900)])?.id).toBe("a");
    expect(bannerPicture({ ...avatar, aspect: 1.5 }, undefined)?.id).toBe("a");
  });
  it("waits for the images when the choice depends on them", () => {
    expect(bannerPicture(avatar, undefined)).toBeUndefined();
  });
});
