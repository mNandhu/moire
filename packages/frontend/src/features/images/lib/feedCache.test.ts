import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ImageDetail } from "./imageFilter";
import { feedItem, imageDetail } from "@/test/images";
import type { FeedPage } from "./imageApi";
import {
  imageDocKey,
  invalidateFeeds,
  syncFeedsFromDoc,
  patchImageInFeeds,
  removeImagesFromFeeds,
  writeImageFields,
} from "./feedCache";

const doc = (id: string, score = 0) => feedItem({ _id: id, score });
const detail = (id: string, score = 0) => imageDetail({ _id: id, score });

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

  it("drops one image from every cached feed, not just one, and keeps the rest", () => {
    const qc = seededClient();

    removeImagesFromFeeds(qc, ["a"]);

    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0].map((d) => d._id)).toEqual(["b"]);
    expect(pagesOf(qc, ["images", 60, { tags: ["cat"] }])[0]).toEqual([]);
  });

  it.each([
    ["an id no feed holds", ["zzz"]],
    ["an empty selection", []],
  ])("is a no-op for %s", (_label, ids) => {
    const qc = seededClient();
    removeImagesFromFeeds(qc, ids);
    expect(pagesOf(qc, ["images", 60, { tags: [] }])[0]).toHaveLength(2);
  });

  it("is a no-op when nothing is cached", () => {
    const qc = new QueryClient();
    expect(() => removeImagesFromFeeds(qc, ["a"])).not.toThrow();
  });

  it("drops them from the grouped view too", () => {
    // Quarantine from selection mode in grouped view: the tile must leave the
    // groups cache now, not when the later invalidation lands.
    const qc = seededClient();
    qc.setQueryData(["image-groups", 60, {}], {
      pages: [
        { items: [doc("a"), doc("c")], next: "0|c" },
        { items: [doc("b")], next: "0|b" },
      ],
      pageParams: [null, "0|c"],
    });

    removeImagesFromFeeds(qc, ["a", "b"]);

    expect(pagesOf(qc, ["image-groups", 60, {}]).map((p) => p.map((d) => d._id))).toEqual([["c"], []]);
    // The server cursors stay: the next page starts where it did.
    const pages = (qc.getQueryData(["image-groups", 60, {}]) as { pages: FeedPage[] }).pages;
    expect(pages.map((p) => p.next)).toEqual(["0|c", "0|b"]);
  });

  it("keeps a batch tile for the refetch to re-pick", () => {
    const qc = seededClient();
    qc.setQueryData(["image-groups", 60, {}], {
      pages: [{ items: [{ ...doc("a"), group_count: 12 }, doc("c")], next: "0|c" }],
      pageParams: [null],
    });

    removeImagesFromFeeds(qc, ["a", "c"]);

    expect(pagesOf(qc, ["image-groups", 60, {}]).map((p) => p.map((d) => d._id))).toEqual([["a"]]);
  });
});

describe("syncFeedsFromDoc", () => {
  it("copies tile fields from the open image's doc into every feed and the grouped view", () => {
    const qc = seededClient();
    qc.setQueryData(["image-groups", 60, {}], {
      pages: [{ items: [doc("a")], next: "0|a" }],
      pageParams: [null],
    });
    syncFeedsFromDoc(
      qc,
      imageDetail({ _id: "a", score: 4, rating: "explicit", has_ai_tags: true, tags: ["ignored"] }),
      Date.now() + 1000,
    );
    for (const key of [["images", 60, { tags: [] }], ["images", 60, { tags: ["cat"] }]]) {
      expect(pagesOf(qc, key)[0][0]).toMatchObject({ score: 4, rating: "explicit", has_ai_tags: true });
      // Only tile fields travel; the full doc's tags stay out of the feed.
      expect("tags" in pagesOf(qc, key)[0][0]).toBe(false);
    }
    expect(pagesOf(qc, ["image-groups", 60, {}])[0][0].score).toBe(4);
  });

  it("leaves pages untouched when nothing changed", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: [] }];
    const before = pagesOf(qc, key)[0];
    const data = qc.getQueryData(key);
    syncFeedsFromDoc(qc, detail("a"), Date.now() + 1000);
    expect(pagesOf(qc, key)[0][0]).toBe(before[0]);
    // The cached data itself, or the gallery re-renders for nothing.
    expect(qc.getQueryData(key)).toBe(data);
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
    qc.setQueryData(imageDocKey("a"), detail("a", 1));
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
    qc.setQueryData(imageDocKey("a"), detail("a", 0));
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
    syncFeedsFromDoc(qc, detail("a", 3), Date.now() + 1000);
    expect(qc.getQueryState(key)!.isInvalidated).toBe(true);
    expect(qc.getQueryState(key)!.dataUpdatedAt).toBe(before);
    expect(pagesOf(qc, key)[0][0].score).toBe(3);
  });

  it("does not touch feeds that don't hold the image", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: ["cat"] }];
    const data = qc.getQueryData(key);
    syncFeedsFromDoc(qc, detail("b", 3), Date.now() + 1000);
    expect(qc.getQueryData(key)).toBe(data);
  });

  it("a doc older than the feed doesn't overwrite the tile", () => {
    const qc = seededClient();
    const key = ["images", 60, { tags: [] }];
    const feedAt = qc.getQueryState(key)!.dataUpdatedAt;
    syncFeedsFromDoc(qc, detail("a", 4), feedAt - 1);
    expect(pagesOf(qc, key)[0][0].score).toBe(0);
  });
});
