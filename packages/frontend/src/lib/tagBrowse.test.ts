import { describe, it, expect } from "vitest";
import type { SignatureRow } from "./gen";
import { groupWorkflows } from "./workflows";
import {
  chartMonths,
  filterTags,
  foundBy,
  galleryTag,
  recentMonths,
  renamableTags,
  sortTags,
  splitSections,
  tagWorkflows,
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

describe("renamableTags / foundBy", () => {
  it("never offers the AI tag, and says who found it", () => {
    const sources = { ai: 3, prompt: 2, manual: 0 };
    expect(renamableTags({ tag: "cat", sources })).toEqual(["prompt:cat"]);
    expect(renamableTags({ tag: "cat", sources: { ai: 1, prompt: 0, manual: 0 } })).toEqual([]);
    expect(foundBy(sources)).toBe("AI and prompts");
    expect(foundBy({ ai: 1, prompt: 1, manual: 1 })).toBe("AI, prompts and you");
    expect(foundBy({ ai: 0, prompt: 0, manual: 2 })).toBe("you");
  });
});
