import { describe, it, expect } from "vitest";
import { DEFAULT_FILTERS } from "./imageFilter";
import { buildImagesQuery } from "./imageApi";

describe("buildImagesQuery", () => {
  it("adds the default limit and no cursor", () => {
    const qs = new URLSearchParams(buildImagesQuery(DEFAULT_FILTERS));
    expect(qs.get("limit")).toBe("100");
    expect(qs.has("cursor")).toBe(false);
  });

  it("adds an explicit cursor and limit", () => {
    const qs = new URLSearchParams(
      buildImagesQuery(DEFAULT_FILTERS, { cursor: "abc", limit: 50 }),
    );
    expect(qs.get("cursor")).toBe("abc");
    expect(qs.get("limit")).toBe("50");
  });
});
