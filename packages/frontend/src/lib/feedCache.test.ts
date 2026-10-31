import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { FeedItem, ImageDetail } from "./imageFilter";
import type { FeedPage } from "./imageApi";
import {
  imageDocKey,
  invalidateFeeds,
  syncFeedsFromDoc,
  patchImageInFeeds,
  removeImageFromFeeds,
  removeImagesFromFeeds,
  writeImageFields,
} from "./feedCache";

const doc = (id: string, score = 0) => ({ _id: id, score }) as FeedItem;

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
  it("invalidates the feed, the batch strip, the grouped view, the tag aggregates, the stats and the facet counts, sizes included", () => {
    const qc = new QueryClient();
    const seen: unknown[] = [];
    qc.invalidateQueries = ((args: { queryKey: unknown }) => {
      seen.push(args.queryKey);
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;

    invalidateFeeds(qc);

    expect(seen).toEqual([["images"], ["batch-strip"], ["image-groups"], ["tags"], ["image-stats"], ["image-models"], ["image-loras"], ["image-embeddings"], ["image-sizes"]]);
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

  it("drops them from the grouped view too", () => {
    // Quarantine from selection mode in grouped view: the tile must leave the
    // groups cache now, not when the later invalidation lands.
    const qc = seededClient();
    qc.setQueryData(["image-groups", 60, {}], {
      pages: [[doc("a"), doc("c")], [doc("b")]],
      pageParams: [0, 60],
    });

    removeImagesFromFeeds(qc, ["a", "b"]);

    const groups = qc.getQueryData(["image-groups", 60, {}]) as { pages: FeedItem[][] };
    expect(groups.pages.map((p) => p.map((d) => d._id))).toEqual([["c"], []]);
  });

  it("keeps a batch tile for the refetch to re-pick", () => {
    const qc = seededClient();
    qc.setQueryData(["image-groups", 60, {}], {
      pages: [[{ ...doc("a"), group_count: 12 }, doc("c")]],
      pageParams: [0],
    });

    removeImagesFromFeeds(qc, ["a", "c"]);

    const groups = qc.getQueryData(["image-groups", 60, {}]) as { pages: FeedItem[][] };
    expect(groups.pages.map((p) => p.map((d) => d._id))).toEqual([["a"]]);
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
    } as ImageDetail, Date.now() + 1000);
    for (const key of [["images", 60, { tags: [] }], ["images", 60, { tags: ["cat"] }]]) {
      expect(pagesOf(qc, key)[0][0]).toMatchObject({ score: 4, rating: "explicit", has_ai_tags: true });
      // Only tile fields travel; the full doc's tags stay out of the feed.
      expect("tags" in pagesOf(qc, key)[0][0]).toBe(false);
    }
    const groups = qc.getQueryData(["image-groups", 60, {}]) as { pages: FeedItem[][] };
    expect(groups.pages[0][0].score).toBe(4);
  });

  it("leaves pages untouched when nothing changed", () => {
    const qc = seededClient();
    const before = pagesOf(qc, ["images", 60, { tags: [] }])[0];
    syncFeedsFromDoc(qc, before[0], Date.now() + 1000);
    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0][0]).toBe(before[0]);
  });
});

describe("writeImageFields", () => {
  const key = ["images", 60, { tags: [] }];

  it("shows the value during the write and keeps it over a fetch that raced it", async () => {
    const qc = seededClient();
    const stale = qc.getQueryData(key);
    await writeImageFields(qc, "a", { score: 5 }, async () => {
      expect(pagesOf(qc, key)[0][0].score).toBe(5);
      qc.setQueryData(key, stale); // a refetch from before the write lands
    });
    expect(pagesOf(qc, key)[0][0].score).toBe(5);
  });

  it("undoes the patch and rethrows when the write fails", async () => {
    const qc = seededClient();
    qc.setQueryData(imageDocKey("a"), doc("a", 1));
    const boom = new Error("boom");
    await expect(writeImageFields(qc, "a", { score: 5 }, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(pagesOf(qc, key)[0][0].score).toBe(0);
    expect((qc.getQueryData(imageDocKey("a")) as ImageDetail).score).toBe(1);
  });

  it("cancels a doc fetch in flight first, under the route's id", async () => {
    const qc = seededClient();
    const spy = vi.spyOn(qc, "cancelQueries");
    await writeImageFields(qc, "L1:a", { score: 2 }, async () => {}, "L1%5Ca");
    expect(spy).toHaveBeenCalledWith({ queryKey: imageDocKey("L1%5Ca"), exact: true });
  });
});

describe("writeImageFields with overlapping writes", () => {
  const key = ["images", 60, { tags: [] }];
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const shown = (qc: QueryClient) => ({
    tile: pagesOf(qc, key)[0][0].score,
    doc: (qc.getQueryData(imageDocKey("a")) as ImageDetail).score,
  });
  /** Score 3 then score 4, both still in flight. */
  async function twoWrites() {
    const qc = seededClient();
    qc.setQueryData(imageDocKey("a"), doc("a", 0));
    const w3 = deferred();
    const w4 = deferred();
    const p3 = writeImageFields(qc, "a", { score: 3 }, () => w3.promise);
    await new Promise((r) => setTimeout(r, 0));
    const p4 = writeImageFields(qc, "a", { score: 4 }, () => w4.promise);
    await new Promise((r) => setTimeout(r, 0));
    expect(shown(qc)).toEqual({ tile: 4, doc: 4 });
    return { qc, w3, w4, p3: p3.catch((e) => e), p4: p4.catch((e) => e) };
  }

  it("an earlier write that succeeds late never brings its value back", async () => {
    const { qc, w3, w4, p3, p4 } = await twoWrites();
    w3.resolve();
    await p3;
    expect(shown(qc)).toEqual({ tile: 4, doc: 4 });
    w4.resolve();
    await p4;
    expect(shown(qc)).toEqual({ tile: 4, doc: 4 });
  });

  it("an earlier write that fails leaves the newer value alone", async () => {
    const { qc, w3, w4, p3, p4 } = await twoWrites();
    w3.reject(new Error("3 failed"));
    await p3;
    expect(shown(qc)).toEqual({ tile: 4, doc: 4 });
    w4.resolve();
    await p4;
    expect(shown(qc)).toEqual({ tile: 4, doc: 4 });
  });

  it("when both fail the value goes back to what it was before either", async () => {
    const { qc, w3, w4, p3, p4 } = await twoWrites();
    w3.reject(new Error("3 failed"));
    await p3;
    w4.reject(new Error("4 failed"));
    await p4;
    expect(shown(qc)).toEqual({ tile: 0, doc: 0 });
  });

  it("the newer write failing falls back to the earlier one still in flight, then to its outcome", async () => {
    const { qc, w3, w4, p3, p4 } = await twoWrites();
    w4.reject(new Error("4 failed"));
    await p4;
    expect(shown(qc)).toEqual({ tile: 3, doc: 3 });
    w3.resolve();
    await p3;
    expect(shown(qc)).toEqual({ tile: 3, doc: 3 });
  });

  it("the newer write failing after the earlier one succeeded shows the earlier value", async () => {
    const { qc, w3, w4, p3, p4 } = await twoWrites();
    w3.resolve();
    await p3;
    w4.reject(new Error("4 failed"));
    await p4;
    expect(shown(qc)).toEqual({ tile: 3, doc: 3 });
  });

  it("a later write starts from the server's value once the earlier ones settled", async () => {
    const { qc, w3, w4, p3, p4 } = await twoWrites();
    w3.resolve();
    w4.resolve();
    await p3;
    await p4;
    await expect(writeImageFields(qc, "a", { score: 5 }, () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(shown(qc)).toEqual({ tile: 4, doc: 4 });
  });
});

describe("patches never fake freshness", () => {
  it("keeps a pending invalidation and the fetch time when patching", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: [] }];
    void qc.invalidateQueries({ queryKey: key, refetchType: "none" });
    const before = qc.getQueryState(key)!.dataUpdatedAt;
    syncFeedsFromDoc(qc, doc("a", 3), Date.now() + 1000);
    expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
    expect(qc.getQueryState(key)!.dataUpdatedAt).toBe(before);
    expect(pagesOf(qc, key)[0][0].score).toBe(3);
  });

  it("does not touch feeds that don't hold the image", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: ["cat"] }];
    const data = qc.getQueryData(key);
    syncFeedsFromDoc(qc, doc("b", 3), Date.now() + 1000);
    expect(qc.getQueryData(key)).toBe(data);
  });

  it("a doc older than the feed doesn't overwrite the tile", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: [] }];
    const feedAt = qc.getQueryState(key)!.dataUpdatedAt;
    syncFeedsFromDoc(qc, doc("a", 4), feedAt - 1);
    expect(pagesOf(qc, key)[0][0].score).toBe(0);
  });
});
