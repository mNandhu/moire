import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS } from "../lib/imageFilter";
import { IMAGE_DOC_PREFIX, IMAGE_FEED_PREFIX, imageDocKey } from "../lib/imageApi";
import { imageFeedKey } from "./useImageFeed";

describe("image cache keys", () => {
  it("put every feed under the prefix invalidations use", () => {
    expect(imageFeedKey(DEFAULT_FILTERS, 60).slice(0, 1)).toEqual([...IMAGE_FEED_PREFIX]);
  });

  it("put every image document under its prefix", () => {
    expect(imageDocKey("L1:a.png")).toEqual([...IMAGE_DOC_PREFIX, "L1:a.png"]);
  });
});

describe("imageFeedKey", () => {
  it("ignores the Group toggle, which the flat feed does not use", () => {
    // /images has no `group` parameter, so both settings fetch the same pages
    // and must share one cache entry.
    expect(imageFeedKey({ ...DEFAULT_FILTERS, group: true }, 60)).toEqual(
      imageFeedKey({ ...DEFAULT_FILTERS, group: false }, 60),
    );
  });
});
