import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { FeedPage, ImageDoc } from "./imageFilter";
import {
  imageDocKey,
  invalidateFeeds,
  patchImageEverywhere,
  syncFeedsFromDoc,
  patchImageInFeeds,
  removeImageFromFeeds,
  removeImagesFromFeeds,
} from "./feedCache";

const doc = (id: string, score = 0) => ({ _id: id, score }) as ImageDoc;

/** Two feeds cached under different filters: the case exact-key patching missed. */
function seededClient() {
  const qc = new QueryClient();
  qc.setQueryData(["images", 60, { tags: [] }], {
    pages: [{ items: [doc("a"), doc("b")], next: "0|b" }],
    pageParams: [null],
  });
  qc.setQueryData(["images", 60, { tags: ["cat"] }], {
    pages: [{ items: [doc("a")], next: "0|a" }],
    pageParams: [null],
  });
  return qc;
}

const pagesOf = (qc: QueryClient, key: unknown[]) =>
  (qc.getQueryData(key) as { pages: FeedPage[] }).pages.map((p) => p.items);

describe("removeImageFromFeeds", () => {
  it("drops the image from every cached feed, not just one", () => {
    const qc = seededClient();

    removeImageFromFeeds(qc, "a");

    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0].map((d) => d._id)).toEqual(["b"]);
    expect(pagesOf(qc, ["images", 60, { tags: ["cat"] }])[0]).toEqual([]);
  });

  it("leaves other images alone", () => {
    const qc = seededClient();
    removeImageFromFeeds(qc, "zzz");
    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0]).toHaveLength(2);
  });

  it("is a no-op when nothing is cached", () => {
    const qc = new QueryClient();
    expect(() => removeImageFromFeeds(qc, "a")).not.toThrow();
  });
});

describe("patchImageInFeeds", () => {
  it("replaces one image everywhere it is cached", () => {
    const qc = seededClient();

    patchImageInFeeds(qc, "a", (d) => ({ ...d, score: 5 }));

    for (const key of [
      ["images", 60, { tags: [] }],
      ["images", 60, { tags: ["cat"] }],
    ]) {
      const found = pagesOf(qc, key)[0].find((d) => d._id === "a");
      expect(found?.score).toBe(5);
    }
  });

  it("does not touch other images", () => {
    const qc = seededClient();
    patchImageInFeeds(qc, "a", (d) => ({ ...d, score: 5 }));
    const b = pagesOf(qc, ["images", 60, { tags: [] }])[0][1];
    expect(b.score).toBe(0);
  });
});

describe("patching keeps server cursors", () => {
  it("rescoring the last item leaves the next-page cursor untouched", () => {
    // Under "top" a score is a sort key; the cursor must stay the one the
    // server sent, or the next page starts in the wrong place.
    const qc = seededClient();
    patchImageInFeeds(qc, "b", (d) => ({ ...d, score: 5 }));
    const data = qc.getQueryData(["images", 60, { tags: [] }]) as { pages: FeedPage[] };
    expect(data.pages[0].next).toBe("0|b");
    expect(data.pages[0].items[1].score).toBe(5);
  });
});

describe("invalidateFeeds", () => {
  it("invalidates the feed, the grouped view, the tag aggregates and the stats", () => {
    const qc = new QueryClient();
    const seen: unknown[] = [];
    qc.invalidateQueries = ((args: { queryKey: unknown }) => {
      seen.push(args.queryKey);
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;

    invalidateFeeds(qc);

    expect(seen).toEqual([["images"], ["image-groups"], ["tags"], ["image-stats"]]);
  });
});

describe("removeImagesFromFeeds", () => {
  it("drops every listed image from every cached feed in one pass", () => {
    // The batch-selection case: the dropdown quarantined N images but never
    // touched the cache, so the grid kept showing them until a manual refresh.
    const qc = seededClient();

    removeImagesFromFeeds(qc, ["a", "b"]);

    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0]).toEqual([]);
    expect(pagesOf(qc, ["images", 60, { tags: ["cat"] }])[0]).toEqual([]);
  });

  it("keeps images that were not selected", () => {
    const qc = seededClient();
    removeImagesFromFeeds(qc, ["a"]);
    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0].map((d) => d._id)).toEqual(["b"]);
  });

  it("is a no-op for an empty selection", () => {
    const qc = seededClient();
    removeImagesFromFeeds(qc, []);
    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0]).toHaveLength(2);
  });
});

describe("syncFeedsFromDoc", () => {
  it("copies tile fields from the open image's doc into every feed and the grouped view", () => {
    const qc = seededClient();
    qc.setQueryData(["image-groups", 60, {}], { pages: [[doc("a")]], pageParams: [0] });
    syncFeedsFromDoc(qc, {
      ...doc("a", 4),
      rating: "explicit",
      has_ai_tags: true,
      tags: ["ignored"],
    } as ImageDoc, Date.now() + 1000);
    for (const key of [["images", 60, { tags: [] }], ["images", 60, { tags: ["cat"] }]]) {
      expect(pagesOf(qc, key)[0][0]).toMatchObject({ score: 4, rating: "explicit", has_ai_tags: true });
      // Only tile fields travel; the full doc's tags stay out of the feed.
      expect(pagesOf(qc, key)[0][0].tags).toBeUndefined();
    }
    const groups = qc.getQueryData(["image-groups", 60, {}]) as { pages: ImageDoc[][] };
    expect(groups.pages[0][0].score).toBe(4);
  });

  it("leaves pages untouched when nothing changed", () => {
    const qc = seededClient();
    const before = pagesOf(qc, ["images", 60, { tags: [] }])[0];
    syncFeedsFromDoc(qc, before[0], Date.now() + 1000);
    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0][0]).toBe(before[0]);
  });
});

describe("patchImageEverywhere", () => {
  it("patches feeds and the doc, and undo restores both", () => {
    const qc = seededClient();
    qc.setQueryData(imageDocKey("a"), { ...doc("a", 1), tags: ["x"] });
    const undo = patchImageEverywhere(qc, "a", { score: 5 });
    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0][0].score).toBe(5);
    expect((qc.getQueryData(imageDocKey("a")) as ImageDoc).score).toBe(5);
    undo();
    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0][0].score).toBe(0);
    expect((qc.getQueryData(imageDocKey("a")) as ImageDoc).score).toBe(1);
  });
});

describe("patches never fake freshness", () => {
  it("keeps a pending invalidation and the fetch time when patching", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: [] }];
    void qc.invalidateQueries({ queryKey: key, refetchType: "none" });
    const before = qc.getQueryState(key)!.dataUpdatedAt;
    patchImageEverywhere(qc, "a", { score: 3 });
    expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
    expect(qc.getQueryState(key)!.dataUpdatedAt).toBe(before);
    expect(pagesOf(qc, key)[0][0].score).toBe(3);
  });

  it("does not touch feeds that don't hold the image", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: ["cat"] }];
    const data = qc.getQueryData(key);
    patchImageEverywhere(qc, "b", { score: 3 });
    expect(qc.getQueryData(key)).toBe(data);
  });

  it("a doc older than the feed doesn't overwrite the tile", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: [] }];
    const feedAt = qc.getQueryState(key)!.dataUpdatedAt;
    syncFeedsFromDoc(qc, doc("a", 4), feedAt - 1);
    expect(pagesOf(qc, key)[0][0].score).toBe(0);
  });

  it("undo leaves a value that changed after the patch alone", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: [] }];
    const undoThree = patchImageEverywhere(qc, "a", { score: 3 });
    patchImageEverywhere(qc, "a", { score: 5 }); // a later edit that succeeded
    undoThree(); // the first write failed late
    expect(pagesOf(qc, key)[0][0].score).toBe(5);
  });
});
