import { describe, expect, it } from "vitest";
import {
  characterItems,
  generationItems,
  imageItems,
  libraryItems,
  resourceItems,
  searchSections,
  tagItems,
  workflowItems,
  type SearchItem,
} from "./search";
import type { CharacterEntry } from "./character";
import type { BrowseTag } from "./tagBrowse";
import type { BatchSummary, Generator } from "./generate";

const page = (label: string, href: string): SearchItem => ({ key: `page:${href}`, group: "pages", label, href });

const character = (tag: string, extra: Partial<CharacterEntry> = {}): CharacterEntry => ({
  tag,
  aliases: [],
  count: 3,
  thumb_url: null,
  thumb_image_id: null,
  name: null,
  series: null,
  color: null,
  focus: null,
  face: null,
  aspect: null,
  ...extra,
});

const tag = (name: string, category: BrowseTag["category"] = "general"): BrowseTag => ({
  tag: name,
  count: 10,
  category,
  last_used: null,
  thumb_image_id: null,
  thumb_url: null,
});

const batch = (id: number, name: string): BatchSummary => ({
  _id: id,
  name,
  generator: "Built-in",
  created_at: 0,
  width: 832,
  height: 1216,
  state: "done",
  requests: 2,
  failed: 0,
  images: 4,
  kept: 4,
  arriving: 0,
  thumbs: ["/t.webp"],
});

describe("search rows", () => {
  it("names characters by their display name and finds them by any tag", () => {
    const [c] = characterItems([character("hu_tao_(genshin_impact)", { aliases: ["hutao"] })]);
    expect(c).toMatchObject({ label: "hu tao", detail: "genshin impact", href: "/characters/hu_tao_(genshin_impact)" });
    expect(searchSections("hutao", [c])[0].items).toEqual([c]);
  });

  it("leaves character tags to the characters group", () => {
    const rows = tagItems([tag("blue_eyes"), tag("hu_tao_(genshin_impact)", "character")]);
    expect(rows.map((r) => r.label)).toEqual(["blue eyes"]);
    expect(rows[0].href).toBe("/tags/blue_eyes");
  });

  it("opens workflows in Generate, batches, libraries and resources in the gallery", () => {
    const [w] = workflowItems([{ _id: "g1", name: "Upscale", kind: "custom", ready: true } as Generator]);
    expect(w.href).toBe("/generate?workflow=g1");
    expect(generationItems([batch(7, "Hu Tao beach")])[0]).toMatchObject({ href: "/generations/7", hint: "4 images" });
    expect(libraryItems([{ _id: "l1", path: "/pics" }, { _id: "l2", path: "/old", deleting: true }])).toHaveLength(1);
    expect(resourceItems("loras", [{ name: "detail", count: 2 }])[0].href).toBe("/?logic=and&lora=detail");
    expect(resourceItems("checkpoints", [{ name: "pony", count: 2 }])[0].href).toContain("model=pony");
  });
});

describe("searchSections", () => {
  const items = [
    page("All Images", "/"),
    page("Generate", "/generate"),
    ...tagItems([tag("blue_eyes"), tag("long_hair")]),
    ...generationItems([1, 2, 3, 4].map((i) => batch(i, `Batch ${i}`))),
  ];

  it("shows pages and the newest generations before anything is typed", () => {
    const s = searchSections("", items);
    expect(s.map((x) => x.group)).toEqual(["pages", "generations"]);
    expect(s[1].items).toHaveLength(3);
  });

  it("treats a space and an underscore as one", () => {
    expect(searchSections("blue eyes", items)[0].items[0].label).toBe("blue eyes");
    expect(searchSections("blue_eyes", items)[0].items[0].label).toBe("blue eyes");
  });

  it("puts the group with the best match first and drops groups with none", () => {
    const s = searchSections("gen", items);
    expect(s.map((x) => x.group)).toEqual(["pages"]);
    expect(searchSections("hair", items)[0].group).toBe("tags");
    expect(searchSections("zzz", items)).toEqual([]);
    // Scattered letters across a long name are noise.
    expect(searchSections("bat 1", items)[0].items[0].label).toBe("Batch 1");
    expect(searchSections("hair", items).map((x) => x.group)).toEqual(["tags"]);
  });
});

describe("imageItems", () => {
  const hits = imageItems([
    { _id: "L1:out/ComfyUI_00123_.png", name: "ComfyUI_00123_.png", folder: "out", thumb_url: "/t/1" },
    { _id: "L1:sunset/a.png", name: "a.png", folder: "sunset", thumb_url: "/t/2" },
    { _id: "L1:top.png", name: "top.png", folder: "", thumb_url: "/t/3" },
  ]);

  it("opens the image and shows its folder", () => {
    expect(hits[0]).toMatchObject({
      group: "images",
      label: "ComfyUI_00123_.png",
      detail: "out",
      href: "/image/L1%3Aout%2FComfyUI_00123_.png",
      thumb: "/t/1",
    });
    expect(hits[2].detail).toBeUndefined();
  });

  it("keeps a hit the server found by name or by folder", () => {
    const labels = (q: string) => searchSections(q, hits).flatMap((s) => s.items.map((i) => i.label));
    expect(labels("comfyui 00123")).toEqual(["ComfyUI_00123_.png"]);
    expect(labels("00123")).toEqual(["ComfyUI_00123_.png"]);
    expect(labels("sunset")).toEqual(["a.png"]);
  });
});
