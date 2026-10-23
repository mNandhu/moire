import { describe, it, expect } from "vitest";
import {
  DEFAULT_FILTERS,
  activeFilterChips,
  parseFilters,
  serializeFilters,
  hasActiveFilter,
  type Filters,
  hasClearableFilter,
  withoutFilters,
} from "./imageFilter";

const roundTrip = (f: Filters): Filters =>
  parseFilters(serializeFilters(f));

describe("Image filter URL round-trip", () => {
  it("preserves the default (empty) filter", () => {
    expect(roundTrip(DEFAULT_FILTERS)).toEqual(DEFAULT_FILTERS);
  });

  it("preserves a fully-populated filter", () => {
    const f: Filters = {
      tags: ["1girl", "solo"],
      logic: "or",
      libraryId: "lib123",
      noTags: false,
      noAiTags: true,
      aiTagged: false,
      quarantined: true,
      promptTerms: ["cyberpunk", "neon"],
      promptLogic: "or",
      model: "sdxl",
      lora: ["detail_xl", "NahidaXL"],
      embedding: ["lazypos"],
      outfit: ["o1", "default:nahida"],
      shape: ["2:3", "3:4"],
      minW: 512,
      maxW: 2048,
      minH: 768,
      maxH: undefined,
      group: true,
      groupId: "abc123",
      workflow: "wf1",
      sort: "oldest",
    };
    expect(roundTrip(f)).toEqual(f);
  });

  it("preserves tag order", () => {
    const f: Filters = { ...DEFAULT_FILTERS, tags: ["b", "a", "c"] };
    expect(roundTrip(f).tags).toEqual(["b", "a", "c"]);
  });
});

describe("parseFilters", () => {
  it("defaults logic to 'and' for missing/invalid values", () => {
    expect(parseFilters(new URLSearchParams()).logic).toBe("and");
    expect(parseFilters(new URLSearchParams("logic=bogus")).logic).toBe("and");
  });

  it("reads the no_tags / no_ai_tags toggles", () => {
    const f = parseFilters(new URLSearchParams("no_tags=1&no_ai_tags=1"));
    expect(f.noTags).toBe(true);
    expect(f.noAiTags).toBe(true);
  });

  it("reads ai_tagged, unless a no-tags toggle contradicts it", () => {
    expect(parseFilters(new URLSearchParams("ai_tagged=1")).aiTagged).toBe(true);
    expect(parseFilters(new URLSearchParams("ai_tagged=1&no_ai_tags=1")).aiTagged).toBe(false);
    const sp = serializeFilters({ ...DEFAULT_FILTERS, aiTagged: true });
    expect(sp.get("ai_tagged")).toBe("1");
    expect(serializeFilters({ ...DEFAULT_FILTERS, aiTagged: true, noTags: true }).has("ai_tagged")).toBe(false);
  });

  it("migrates the legacy singular `tag` param", () => {
    const f = parseFilters(new URLSearchParams("tag=cat&tag=dog"));
    expect(f.tags).toEqual(["cat", "dog"]);
    // re-serializing emits the modern `tags` param
    expect(serializeFilters(f).getAll("tags")).toEqual(["cat", "dog"]);
    expect(serializeFilters(f).getAll("tag")).toEqual([]);
  });

  it("prefers `tags` over legacy `tag` when both present", () => {
    const f = parseFilters(new URLSearchParams("tags=new&tag=old"));
    expect(f.tags).toEqual(["new"]);
  });
});

describe("serializeFilters", () => {
  it("omits falsy/default values", () => {
    const sp = serializeFilters(DEFAULT_FILTERS);
    expect(sp.has("library_id")).toBe(false);
    expect(sp.has("no_tags")).toBe(false);
    expect(sp.has("no_ai_tags")).toBe(false);
  });

  it("never includes pagination params", () => {
    const sp = serializeFilters({ ...DEFAULT_FILTERS, tags: ["x"] });
    expect(sp.has("cursor")).toBe(false);
    expect(sp.has("limit")).toBe(false);
  });
});

describe("sort", () => {
  it("round-trips, leaves the default out of the URL, and isn't a filter", () => {
    const top = { ...DEFAULT_FILTERS, sort: "top" as const };
    expect(roundTrip(top)).toEqual(top);
    expect(serializeFilters(DEFAULT_FILTERS).has("sort")).toBe(false);
    expect(parseFilters(new URLSearchParams("sort=bogus")).sort).toBe("newest");
    expect(hasActiveFilter(top)).toBe(false);
    expect(activeFilterChips(top)).toEqual([]);
  });
});

describe("workflow filter", () => {
  it("round-trips a family or a version through the URL", () => {
    const fam = { ...DEFAULT_FILTERS, workflow: "49a0c942" };
    expect(roundTrip(fam)).toEqual(fam);
    const ver = { ...DEFAULT_FILTERS, workflowSig: "abc123" };
    expect(roundTrip(ver)).toEqual(ver);
    expect(serializeFilters(fam).get("workflow")).toBe("49a0c942");
    expect(hasActiveFilter(ver)).toBe(true);
  });

  it("names the chip and clears both keys", () => {
    const [chip] = activeFilterChips(
      { ...DEFAULT_FILTERS, workflowSig: "abc" },
      undefined,
      (k) => (k.workflowSig === "abc" ? "RemoteQ · Oct 3" : undefined),
    );
    expect(chip.label).toBe("Workflow: RemoteQ · Oct 3");
    expect(chip.without.workflowSig).toBeUndefined();
  });
});

describe("hasActiveFilter", () => {
  it("is false for the default (empty) filter", () => {
    expect(hasActiveFilter(DEFAULT_FILTERS)).toBe(false);
  });

  it("is true when any axis is set", () => {
    expect(hasActiveFilter({ ...DEFAULT_FILTERS, tags: ["cat"] })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULT_FILTERS, libraryId: "L1" })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULT_FILTERS, noTags: true })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULT_FILTERS, minW: 100 })).toBe(true);
    expect(hasActiveFilter({ ...DEFAULT_FILTERS, groupId: "g" })).toBe(true);
  });

  it("ignores the grouped-view toggle (group) which is not a filter", () => {
    expect(hasActiveFilter({ ...DEFAULT_FILTERS, group: true })).toBe(false);
  });
});

describe("activeFilterChips", () => {
  const f = (patch: Partial<typeof DEFAULT_FILTERS>) => ({ ...DEFAULT_FILTERS, ...patch });

  it("is empty for the default feed, and ignores search tags", () => {
    expect(activeFilterChips(DEFAULT_FILTERS)).toEqual([]);
    expect(activeFilterChips(f({ tags: ["cat", "dog"] }))).toEqual([]);
  });

  it("labels each active filter and removes only that one", () => {
    const filters = f({ noTags: true, quarantined: true, model: "sdxl" });
    const chips = activeFilterChips(filters);
    expect(chips.map((c) => c.label)).toEqual(["Untagged", "Quarantined", "Model: sdxl"]);
    const untagged = chips[0].without;
    expect(untagged.noTags).toBe(false);
    expect(untagged.quarantined).toBe(true);
    expect(untagged.model).toBe("sdxl");
  });

  it("resolves the library name, falling back to the id", () => {
    expect(activeFilterChips(f({ libraryId: "L1" }), () => "scary")[0].label).toBe("Library: scary");
    expect(activeFilterChips(f({ libraryId: "L1" }))[0].label).toBe("Library: L1");
  });

  it("only shows OR mode when it changes the result", () => {
    expect(activeFilterChips(f({ logic: "or", tags: ["a"] }))).toEqual([]);
    const [chip] = activeFilterChips(f({ logic: "or", tags: ["a", "b"] }));
    expect(chip.label).toBe("Match any of 2 tags");
    expect(chip.without.logic).toBe("and");
    expect(chip.without.tags).toEqual(["a", "b"]);
  });

  it("gives each prompt term its own chip", () => {
    const chips = activeFilterChips(f({ promptTerms: ["neon", "rain"] }));
    expect(chips.map((c) => c.label)).toEqual(["Prompt: neon", "Prompt: rain"]);
    expect(chips[0].without.promptTerms).toEqual(["rain"]);
  });

  it("collapses a size range into one chip that clears both bounds", () => {
    expect(activeFilterChips(f({ minW: 512 }))[0].label).toBe("Width ≥ 512");
    expect(activeFilterChips(f({ maxH: 900 }))[0].label).toBe("Height ≤ 900");
    const [w] = activeFilterChips(f({ minW: 512, maxW: 1024 }));
    expect(w.label).toBe("Width 512–1024");
    expect(w.without.minW).toBeUndefined();
    expect(w.without.maxW).toBeUndefined();
  });

  it("shows the chosen size presets as one chip", () => {
    const [c] = activeFilterChips(f({ shape: ["2:3", "3:4"] }));
    expect(c.label).toBe("Size: 2:3, 3:4");
    expect(c.without.shape).toEqual([]);
  });
});


describe("withoutFilters", () => {
  it("clears the panel's filters but keeps the search, tab, order and grouping", () => {
    const f: Filters = {
      ...DEFAULT_FILTERS,
      tags: ["tokitou_muichirou"],
      logic: "or",
      libraryId: "lib1",
      sort: "top",
      group: true,
      noAiTags: true,
      model: "sdxl",
      embedding: ["lazypos"],
    };
    expect(withoutFilters(f)).toEqual({
      ...DEFAULT_FILTERS,
      tags: ["tokitou_muichirou"],
      // embeddings are search terms too: they stay
      embedding: ["lazypos"],
      logic: "or",
      libraryId: "lib1",
      sort: "top",
      group: true,
    });
    expect(hasClearableFilter(f)).toBe(true);
    expect(hasClearableFilter(withoutFilters(f))).toBe(false);
  });
});


describe("lora filter", () => {
  it("reads an old single-lora link", () => {
    expect(parseFilters(new URLSearchParams("lora=detail_xl")).lora).toEqual(["detail_xl"]);
  });
});
