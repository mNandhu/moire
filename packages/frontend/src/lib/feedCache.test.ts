import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ImageDoc } from "./imageFilter";
import {
  invalidateFeeds,
  patchImageInFeeds,
  removeImageFromFeeds,
  removeImagesFromFeeds,
} from "./feedCache";

const doc = (id: string, score = 0) => ({ _id: id, score }) as ImageDoc;

/** Two feeds cached under different filters — the case exact-key patching missed. */
function seededClient() {
  const qc = new QueryClient();
  qc.setQueryData(["images", 60, { tags: [] }], {
    pages: [[doc("a"), doc("b")]],
    pageParams: [null],
  });
  qc.setQueryData(["images", 60, { tags: ["cat"] }], {
    pages: [[doc("a")]],
    pageParams: [null],
  });
  return qc;
}

const pagesOf = (qc: QueryClient, key: unknown[]) =>
  (qc.getQueryData(key) as { pages: ImageDoc[][] }).pages;

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

describe("invalidateFeeds", () => {
  it("invalidates the feed, the grouped view and the tag aggregates", () => {
    const qc = new QueryClient();
    const seen: unknown[] = [];
    qc.invalidateQueries = ((args: { queryKey: unknown }) => {
      seen.push(args.queryKey);
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;

    invalidateFeeds(qc);

    expect(seen).toEqual([["images"], ["image-groups"], ["tags"]]);
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
