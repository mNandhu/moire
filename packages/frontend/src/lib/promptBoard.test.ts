import { describe, expect, it } from "vitest";
import { promptTerms } from "./promptOutline";
import {
  coversOf,
  groupByBox,
  isClearable,
  layerTerm,
  liveStrikes,
  placeTerms,
  rankOptions,
  repeatedTags,
  type BoardLayer,
  type Cover,
} from "./promptBoard";
import type { TagPlace } from "./queries";

const place = (section: TagPlace["section"], alias_of?: string): TagPlace => ({ section, alias_of }) as TagPlace;
const none = () => false;

describe("placeTerms", () => {
  it("files terms by place, kind and boilerplate", () => {
    const terms = promptTerms("1girl, blue_eyes, masterpiece, <lora:foo:0.8>, mystery");
    const placed = placeTerms(terms, { "1girl": place("subject"), blue_eyes: place("eyes") }, (n) => n === "masterpiece");
    expect(placed.map((t) => [t.name, t.box])).toEqual([
      ["1girl", "subject"],
      ["blue_eyes", "eyes"],
      ["masterpiece", "quality"],
      ["<lora:foo:0.8>", "resources"],
      ["mystery", "other"],
    ]);
  });

  it("files an alias of boilerplate as quality", () => {
    const [t] = placeTerms(promptTerms("hq"), { hq: place("other", "best_quality") }, (n) => n === "best_quality");
    expect(t.box).toBe("quality");
  });
});

describe("repeatedTags", () => {
  it("counts an alias as its tag and skips struck-out ones", () => {
    const mine = placeTerms(promptTerms("long_hair, hair_long"), { hair_long: place("hair", "long_hair") }, none);
    const layer = placeTerms([layerTerm({ tag: "long_hair", dropped: true })], undefined, none);
    expect([...repeatedTags([...mine, ...layer])]).toEqual(["long_hair"]);
    expect(repeatedTags(mine.slice(0, 1))).toEqual(new Set());
  });
});

describe("groupByBox", () => {
  it("keeps order within a box", () => {
    const placed = placeTerms(promptTerms("long_hair, blue_eyes, ponytail"), { long_hair: place("hair"), blue_eyes: place("eyes"), ponytail: place("hair") }, none);
    const by = groupByBox(placed);
    expect(by.get("hair")?.map((t) => t.name)).toEqual(["long_hair", "ponytail"]);
    expect(by.get("eyes")?.map((t) => t.name)).toEqual(["blue_eyes"]);
  });
});

describe("layer covers", () => {
  const layer: BoardLayer = { key: "c", label: "Rem", tags: [] };
  const toggled = () => {};
  const terms = placeTerms(
    [layerTerm({ tag: "Rem", self: true }), layerTerm({ tag: "blue_hair", onToggle: toggled }), layerTerm({ tag: "ribbon", dropped: true, onToggle: toggled })],
    { rem: place("subject"), blue_hair: place("hair"), ribbon: place("hair") },
    none,
  );
  const covers: Cover[] = [{ layer, terms }];

  it("lists a box's terms without the character's own tag", () => {
    expect(coversOf(covers, "subject")).toEqual([]);
    expect(coversOf(covers, "hair")[0].terms.map((t) => t.name)).toEqual(["blue_hair", "ribbon"]);
  });

  it("strikes only what is still on", () => {
    expect(liveStrikes(covers, "hair")[0].tags).toEqual(["blue_hair"]);
  });

  it("is clearable when the Prompt or a layer has something to take out", () => {
    expect(isClearable("hair", new Map(), covers)).toBe(true);
    expect(isClearable("subject", new Map(), covers)).toBe(false);
    expect(isClearable("quality", new Map([["quality", [terms[0]]]]), covers)).toBe(false);
    expect(isClearable("eyes", new Map([["eyes", [terms[0]]]]), [])).toBe(true);
  });
});

describe("rankOptions", () => {
  it("leaves out what is present, library count first then posts", () => {
    const out = rankOptions(
      { hair: [["a", 900], ["b", 100], ["c", 500], ["d", 50]] },
      new Set(["d"]),
      new Map([["b", 3], ["c", 3]]),
    );
    expect(out.get("hair")).toEqual([
      { _id: "c", count: 3 },
      { _id: "b", count: 3 },
      { _id: "a", count: 0 },
    ]);
  });

  it("is empty before the offers load", () => {
    expect(rankOptions(undefined, new Set(), new Map()).size).toBe(0);
  });
});
