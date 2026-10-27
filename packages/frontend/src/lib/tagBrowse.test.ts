import { describe, it, expect } from "vitest";
import type { SignatureRow } from "./rules";
import { groupWorkflows } from "./workflows";
import {
  chartMonths,
  filterTags,
  galleryTag,
  recentMonths,
  renamableTags,
  sortTags,
  splitSections,
  tagWorkflows,
  renameMessage,
  undoRuleMessage,
  acceptMessage,
  type BrowseTag,
} from "./tagBrowse";

const tag = (name: string, count: number, over: Partial<BrowseTag> = {}): BrowseTag => ({
  tag: name,
  count,
  category: "general",
  last_used: null,
  thumb_image_id: null,
  thumb_url: null,
  ...over,
});

describe("galleryTag", () => {
  it("links to the same images the entry counts", () => {
    expect(galleryTag("cat", "all")).toBe("any:cat");
    expect(galleryTag("cat", "ai")).toBe("cat");
    expect(galleryTag("cat", "prompt")).toBe("prompt:cat");
    expect(galleryTag("cat", "manual")).toBe("manual:cat");
  });
});

describe("filterTags", () => {
  const rows = [tag("blue_eyes", 3), tag("masterpiece", 9), tag("cat", 1)];
  it("matches either spelling and drops boilerplate", () => {
    const bp = (t: string) => t === "masterpiece";
    expect(filterTags(rows, "blue eyes", bp).map((r) => r.tag)).toEqual(["blue_eyes"]);
    expect(filterTags(rows, "", bp).map((r) => r.tag)).toEqual(["blue_eyes", "cat"]);
    expect(filterTags(rows, "", null)).toHaveLength(3);
  });
  it("ignores word breaks", () => {
    const more = [tag("highleg_leotard", 2), tag("high_heels", 4)];
    expect(filterTags(more, "high leg", null).map((r) => r.tag)).toEqual(["highleg_leotard"]);
    expect(filterTags(more, "highheels", null).map((r) => r.tag)).toEqual(["high_heels"]);
  });
});

describe("sortTags", () => {
  const rows = [
    tag("b", 5, { last_used: 10 }),
    tag("a", 5, { last_used: null }),
    tag("c", 9, { last_used: 30 }),
  ];
  it("orders by count, name or last use, ties by name", () => {
    expect(sortTags(rows, "count").map((r) => r.tag)).toEqual(["c", "a", "b"]);
    expect(sortTags(rows, "name").map((r) => r.tag)).toEqual(["a", "b", "c"]);
    expect(sortTags(rows, "recent").map((r) => r.tag)).toEqual(["c", "b", "a"]);
  });
  it("leaves its input alone", () => {
    sortTags(rows, "name");
    expect(rows[0].tag).toBe("b");
  });
});

describe("splitSections", () => {
  it("puts characters in their own section, order kept", () => {
    const rows = [tag("x", 1), tag("frieren", 2, { category: "character" }), tag("y", 3)];
    const { characters, general } = splitSections(rows);
    expect(characters.map((r) => r.tag)).toEqual(["frieren"]);
    expect(general.map((r) => r.tag)).toEqual(["x", "y"]);
  });
});

describe("recentMonths", () => {
  it("fills the months with none, oldest first, ending this month", () => {
    const got = recentMonths(
      [
        { month: "2025-12", count: 4 },
        { month: "2026-02", count: 1 },
        { month: "2024-01", count: 99 },
      ],
      3,
      new Date(2026, 1, 15),
    );
    expect(got).toEqual([
      { month: "2025-12", count: 4 },
      { month: "2026-01", count: 0 },
      { month: "2026-02", count: 1 },
    ]);
  });
});

describe("chartMonths", () => {
  const now = new Date(2026, 9, 15);
  const at = (y: number, m: number) => new Date(y, m - 1, 2).getTime() / 1000;
  it("reaches back to the first use, between one and two years", () => {
    expect(chartMonths(null, now)).toBe(12);
    expect(chartMonths(at(2026, 8), now)).toBe(12);
    expect(chartMonths(at(2025, 3), now)).toBe(20);
    expect(chartMonths(at(2020, 1), now)).toBe(24);
  });
});

describe("tagWorkflows", () => {
  const sig = (workflow_sig: string, workflow_id: string | null, name?: string): SignatureRow => ({
    workflow_sig,
    count: 1,
    needs_mapping: 0,
    sample_image_id: "L:x.png",
    has_ruleset: false,
    workflow_id,
    workflow_name: name ?? null,
  });
  it("adds a family's versions up and names them like the Rules page", () => {
    const families = groupWorkflows([sig("s1", "W", "Upscale"), sig("s2", "W"), sig("s3", "V")]);
    const got = tagWorkflows(
      [
        { sig: "s1", count: 3 },
        { sig: "s2", count: 2 },
        { sig: "s3", count: 4 },
        { sig: "gone", count: 1 },
      ],
      families,
    );
    expect(got).toEqual([
      { name: "Upscale", count: 5, filter: { workflow: "W" } },
      { name: "Unnamed workflow", count: 4, filter: { workflow: "V" } },
      { name: "Unnamed workflow", count: 1, filter: { workflowSig: "gone" } },
    ]);
  });
  it("names images outside every family one version at a time", () => {
    const families = groupWorkflows([sig("a", null), sig("b", null)]);
    const got = tagWorkflows(
      [
        { sig: "a", count: 2 },
        { sig: "b", count: 1 },
      ],
      families,
    );
    expect(got.map((w) => w.filter)).toEqual([{ workflowSig: "a" }, { workflowSig: "b" }]);
    expect(got[0].name).toMatch(/^Other images · /);
    expect(got[0].name).not.toBe(got[1].name);
  });
});

describe("renamableTags", () => {
  it("never offers the AI tag", () => {
    const sources = { ai: 3, prompt: 2, manual: 0 };
    expect(renamableTags({ tag: "cat", sources })).toEqual(["prompt:cat"]);
    expect(renamableTags({ tag: "cat", sources: { ai: 1, prompt: 0, manual: 0 } })).toEqual([]);
  });
});

describe("renameMessage", () => {
  it("says Renamed for a manual tag and Merged for a prompt tag", () => {
    expect(renameMessage({ kind: "manual", from: "manual:blue_eyes", to: "manual:aqua_eyes", images: 3 })).toBe(
      "Renamed “blue eyes” into “aqua eyes” on 3 images",
    );
    expect(renameMessage({ kind: "prompt", from: "prompt:cat", to: "prompt:dog", images: 1, background: true })).toBe(
      "Merged “cat” into “dog” on 1 images, updating them in the background",
    );
  });
  it("names every target of a split", () => {
    expect(
      renameMessage({ kind: "prompt", from: "prompt:ab", to: "prompt:a", to_all: ["prompt:a", "prompt:b"], images: 2 }),
    ).toBe("Merged “ab” into “a + b” on 2 images");
  });
});

describe("undoRuleMessage", () => {
  it("names the rule and the background update", () => {
    expect(undoRuleMessage({ from: "ab", to: ["a", "b"] })).toBe("Removed rule “ab” → “a + b”");
    expect(undoRuleMessage({ from: "x", to: ["y"], background: true })).toBe(
      "Removed rule “x” → “y”, updating its images in the background",
    );
  });
});

describe("acceptMessage", () => {
  const skip = (from: string) => ({ from, reason: "loop" });
  it("counts tags and images", () => {
    expect(acceptMessage({ rules: 1, skipped: [], images: 5, background: false })).toBe("Merged 1 tag on 5 images");
    expect(acceptMessage({ rules: 2, skipped: [], images: 5, background: true })).toBe(
      "Merged 2 tags on 5 images, updating them in the background",
    );
  });
  it("names up to three skipped rules and counts the rest", () => {
    expect(acceptMessage({ rules: 0, skipped: [skip("a_b")], images: 0, background: false })).toBe(
      "Merged 0 tags on 0 images; skipped “a b” (loop)",
    );
    expect(
      acceptMessage({ rules: 0, skipped: ["a", "b", "c"].map(skip), images: 0, background: false }),
    ).toBe("Merged 0 tags on 0 images; skipped “a” (loop), “b” (loop), “c” (loop)");
    expect(
      acceptMessage({ rules: 0, skipped: ["a", "b", "c", "d", "e"].map(skip), images: 0, background: false }),
    ).toBe("Merged 0 tags on 0 images; skipped “a” (loop), “b” (loop), “c” (loop) and 2 more");
  });
});
