import { describe, expect, it } from "vitest";
import { addWorn, keepPicked, outfitGalleryHref, outfitInput, pickFromInput, pickOf, toggleWorn, validOutfits, wornTags } from "./outfit";
import { formFromBatch, loadDraft, previewText, wearingOutfit, withCharacter } from "./generateForm";
import type { BatchInputs } from "./generate";
import { DEFAULT_FILTERS, searchTerms, withSearchTerms } from "./imageFilter";

const funeral = pickOf({
  _id: "o1",
  name: "Funeral director",
  tags: [
    { tag: "porkpie_hat", group: "headwear", checkable: true },
    { tag: "long_coat", group: "coat", checkable: true },
  ],
});

describe("outfit picks", () => {
  it("strikes, restores and adds tags for this batch only", () => {
    const struck = toggleWorn(funeral, "long_coat");
    expect(wornTags(struck)).toEqual(["porkpie_hat"]);
    expect(wornTags(toggleWorn(struck, "long_coat"))).toEqual(["porkpie_hat", "long_coat"]);
    expect(addWorn(funeral, "black shorts").tags).toEqual(["porkpie_hat", "long_coat", "black_shorts"]);
    // Adding a struck tag brings it back instead of listing it twice.
    expect(addWorn(struck, "long_coat")).toEqual(funeral);
  });

  it("sends nothing when every tag is struck", () => {
    expect(outfitInput(funeral)).toEqual({ id: "o1", name: "Funeral director", tags: ["porkpie_hat", "long_coat"] });
    expect(outfitInput(toggleWorn(toggleWorn(funeral, "porkpie_hat"), "long_coat"))).toBeNull();
    expect(outfitInput(undefined)).toBeNull();
  });

  it("keeps only picks of characters still in the prompt", () => {
    expect(keepPicked({ a: funeral, b: funeral }, ["b"])).toEqual({ b: funeral });
  });

  it("drops malformed stored picks", () => {
    expect(validOutfits({ a: funeral, b: { id: 1 }, c: null })).toEqual({ a: funeral });
    expect(validOutfits([funeral])).toEqual({});
    expect(pickFromInput({ id: "o1", name: "x", tags: ["hat"] })).toEqual({ id: "o1", name: "x", tags: ["hat"], dropped: [] });
  });
});

describe("outfits in the composer", () => {
  it("previews each character's outfit right after them", () => {
    const text = previewText(
      [{ kind: "character" }, { kind: "text", role: "prompt", text: "night" }],
      [["hu_tao", "red_eyes"], ["porkpie_hat"], ["furina"], []],
    );
    expect(text).toBe("hu_tao, red_eyes, porkpie_hat, furina, night");
  });

  it("brings a batch's recorded outfit back on Edit and queue", () => {
    const inputs = {
      base: "",
      extra: [],
      negative_base: "",
      negative_extra: [],
      checkpoint: null,
      loras: [],
      characters: [
        { tag: "hu_tao", label: "Hu Tao", tags: ["hu_tao"], lora: null, outfit: { id: "o1", name: "Funeral", tags: ["porkpie_hat"] } },
        { tag: "furina", label: "Furina", tags: ["furina"], lora: null },
      ],
      width: 832,
      height: 1216,
      seed: { mode: "random", value: null },
      count: 1,
      per_request: null,
      positive_text: "",
      negative_text: "",
    } as BatchInputs;
    const f = formFromBatch(inputs, null);
    expect(f.outfits).toEqual({ hu_tao: { id: "o1", name: "Funeral", tags: ["porkpie_hat"], dropped: [] } });
  });

  it("keeps a draft's picks for characters it still has", () => {
    const store = {
      getItem: () => JSON.stringify({ characters: ["hu_tao"], outfits: { hu_tao: funeral, gone: funeral } }),
    };
    expect(loadDraft(store).outfits).toEqual({ hu_tao: funeral });
  });
});

describe("outfitGalleryHref", () => {
  it("uses the outfit filter, with the character from their page", () => {
    const sp = new URLSearchParams(outfitGalleryHref({ _id: "o1", character: "hu_tao" }, "hu_tao").slice(2));
    expect([sp.getAll("outfit"), sp.getAll("tags")]).toEqual([["o1"], ["hu_tao"]]);
  });

  it("names a Default by its character", () => {
    const sp = new URLSearchParams(outfitGalleryHref({ _id: "default", character: "nahida" }).slice(2));
    expect([sp.getAll("outfit"), sp.getAll("tags")]).toEqual([["default:nahida"], []]);
  });
});

describe("outfits in the search box", () => {
  const list = [{ id: "o1", name: "Night out" }];
  const base = { ...DEFAULT_FILTERS };

  it("shows outfit chips by name and maps them back to ids", () => {
    const f = { ...base, outfit: ["o1", "default:nahida"] };
    const terms = searchTerms(f, list);
    expect(terms).toEqual(["outfit:Night out", "outfit:Default, nahida"]);
    expect(withSearchTerms(f, terms, {}, { list }).outfit).toEqual(["o1", "default:nahida"]);
  });

  it("resolves a typed outfit name, prefixed or plain, unless it is a tag", () => {
    expect(withSearchTerms(base, ["outfit:night OUT"], {}, { list }).outfit).toEqual(["o1"]);
    const plain = withSearchTerms(base, ["Night out"], {}, { list });
    expect([plain.outfit, plain.tags]).toEqual([["o1"], []]);
    const tag = withSearchTerms(base, ["Night out"], {}, { list, tags: new Set(["Night_out"]) });
    expect([tag.outfit, tag.tags]).toEqual([[], ["Night out"]]);
    // An unknown name is dropped, not searched as an id.
    expect(withSearchTerms(base, ["outfit:nope"], {}, { list }).outfit).toEqual([]);
  });
});

describe("fresh characters", () => {
  it("marks a character page's pick to start as Settings says", () => {
    const f = withCharacter({ ...loadDraft(null), outfits: { old: funeral } }, "hu_tao");
    expect([f.characters, f.outfits, f.fresh]).toEqual([["hu_tao"], {}, ["hu_tao"]]);
  });

  it("keeps a draft's fresh marks only for its characters", () => {
    const store = { getItem: () => JSON.stringify({ characters: ["a"], fresh: ["a", "b", 3] }) };
    expect(loadDraft(store).fresh).toEqual(["a"]);
  });
});

describe("wearingOutfit", () => {
  it("puts the character in the draft wearing the outfit, settled", () => {
    const f = wearingOutfit({ ...loadDraft(null), prompt: "cafe", fresh: ["x"] }, "kana", funeral);
    expect([f.characters, f.outfits, f.fresh, f.prompt]).toEqual([["kana"], { kana: funeral }, [], "cafe"]);
  });
});
