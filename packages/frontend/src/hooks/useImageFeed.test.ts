import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS } from "../lib/imageFilter";
import { imageFeedKey } from "./useImageFeed";

describe("imageFeedKey", () => {
  it("ignores the Group toggle, which the flat feed does not use", () => {
    // /images has no `group` parameter, so both settings fetch the same pages
    // and must share one cache entry.
    expect(imageFeedKey({ ...DEFAULT_FILTERS, group: true }, 60)).toEqual(
      imageFeedKey({ ...DEFAULT_FILTERS, group: false }, 60),
    );
  });
});
