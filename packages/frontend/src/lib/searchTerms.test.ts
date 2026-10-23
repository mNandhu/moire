import { describe, it, expect } from "vitest";
import { DEFAULT_FILTERS, serializeFilters, type Filters } from "./imageFilter";
import { resourceOf, searchTerms, withSearchTerms } from "./searchTerms";

describe("search terms", () => {
  it("shows loras and embeddings as prefixed chips after the tags", () => {
    const f: Filters = { ...DEFAULT_FILTERS, tags: ["1girl"], lora: ["NahidaXL"], embedding: ["lazypos"] };
    expect(searchTerms(f)).toEqual(["1girl", "lora:NahidaXL", "embedding:lazypos"]);
  });

  it("puts typed terms back where they belong, in the library's spelling", () => {
    const f = withSearchTerms(DEFAULT_FILTERS, ["1girl", "lora:nahidaxl", "EMB: badhandv4", "lora:NahidaXL"], {
      lora: ["NahidaXL"],
      embedding: ["badhandv4"],
    });
    expect(f.tags).toEqual(["1girl"]);
    expect(f.lora).toEqual(["NahidaXL"]);
    expect(f.embedding).toEqual(["badhandv4"]);
    expect(serializeFilters(f).getAll("tags")).toEqual(["1girl"]);
  });

  it("knows a resource term from a tag", () => {
    expect(resourceOf("lora:x")).toEqual({ kind: "lora", name: "x" });
    expect(resourceOf("embedding:lazypos")).toEqual({ kind: "embedding", name: "lazypos" });
    expect(resourceOf("prompt:lora")).toBeNull();
    expect(resourceOf("lora:")).toBeNull();
  });
});
