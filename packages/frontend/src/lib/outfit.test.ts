import { describe, expect, it } from "vitest";
import {
  addWorn,
  keepPicked,
  outfitGalleryHref,
  outfitInput,
  outfitModeOf,
  outfitSavePlan,
  outfitsHref,
  pickFromInput,
  pickOf,
  seedOutfit,
  suggestOutfitName,
  restoreWorn,
  strikeWorn,
  toggleWorn,
  validOutfits,
  wornTags,
} from "./outfit";
import { previewText } from "./generateForm";
import { loadDraft } from "./generateDraft";
import { formFromBatch, wearingOutfit, withCharacter } from "./remixForm";
import type { BatchInputs, Outfit, OutfitTag } from "./generate";
import { DEFAULT_FILTERS } from "./imageFilter";
import { searchTerms, withSearchTerms } from "./searchTerms";

const funeral = pickOf({
  _id: "o1",
  name: "Funeral director",
  tags: [
    { tag: "porkpie_hat", group: "headwear", checkable: true },
    { tag: "long_coat", group: "coat", checkable: true },
  ],
});

describe("outfit picks", () => {
  it("restores struck and removed tags, keeping what was added since", () => {
    const before = addWorn(funeral, "black shorts");
    const struck = strikeWorn(before, ["porkpie_hat", "black_shorts"]);
    const later = addWorn(struck, "scarf");
    const back = restoreWorn(later, before, ["porkpie_hat", "black_shorts"]);
    expect(wornTags(back)).toEqual(["porkpie_hat", "long_coat", "black_shorts", "scarf"]);
    expect(back.added).toEqual(["black_shorts", "scarf"]);
  });

  it("strikes several tags at once, leaving struck ones struck", () => {
    const struck = toggleWorn(funeral, "long_coat");
    expect(wornTags(strikeWorn(struck, ["porkpie_hat", "long_coat"]))).toEqual([]);
    expect(strikeWorn(struck, ["long_coat"]).dropped).toEqual(["long_coat"]);
    expect(strikeWorn(funeral, ["scarf"])).toEqual(funeral);
  });

  it("strikes, restores and adds tags for this batch only", () => {
    const struck = toggleWorn(funeral, "long_coat");
    expect(wornTags(struck)).toEqual(["porkpie_hat"]);
    expect(wornTags(toggleWorn(struck, "long_coat"))).toEqual(["porkpie_hat", "long_coat"]);
    expect(addWorn(funeral, "black shorts").tags).toEqual(["porkpie_hat", "long_coat", "black_shorts"]);
    // Adding a struck tag brings it back instead of listing it twice.
    expect(addWorn(struck, "long_coat")).toEqual(funeral);
  });

  it("removes a tag added for this batch instead of striking it", () => {
    const added = addWorn(funeral, "black shorts");
    expect(added.added).toEqual(["black_shorts"]);
    const gone = toggleWorn(added, "black_shorts");
    expect(gone.tags).toEqual(["porkpie_hat", "long_coat"]);
    expect(gone.dropped).toEqual([]);
    expect(gone.added).toEqual([]);
    // The outfit's own tags still strike.
    expect(toggleWorn(added, "long_coat").dropped).toEqual(["long_coat"]);
  });

  it("keeps a stored pick's added tags that it still lists", () => {
    const stored = { ...funeral, tags: [...funeral.tags, "black_shorts"], added: ["black_shorts", "stray"] };
    expect(validOutfits({ a: stored }).a.added).toEqual(["black_shorts"]);
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

describe("outfitsHref", () => {
  it("filters the Outfits page to a character", () => {
    expect(outfitsHref("kafka_(honkai:_star_rail)")).toBe("/outfits?character=kafka_(honkai%3A_star_rail)");
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

  it("ends a remix the draft was, and the image's seed with it", () => {
    const remixed = { ...loadDraft(null), remix: { image: "L1:a.png", seed: 3 }, seed: { mode: "fixed" as const, value: 3 } };
    const f = withCharacter(remixed, "hu_tao");
    expect([f.remix, f.seed]).toEqual([null, { mode: "random", value: null }]);
    // A seed the user set after is theirs.
    expect(withCharacter({ ...remixed, seed: { mode: "fixed", value: 7 } }, "hu_tao").seed).toEqual({ mode: "fixed", value: 7 });
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

  it("ends a remix the draft was", () => {
    expect(wearingOutfit({ ...loadDraft(null), remix: { image: "L1:a.png", seed: 3 } }, "kana", funeral).remix).toBeNull();
  });
});

describe("suggestOutfitName", () => {
  const row = (tag: string, group: string | null, source = "image") => ({ tag, group, source });
  it("names the main garment, then the next piece", () => {
    expect(
      suggestOutfitName([
        row("shell_necklace", "neck_and_neckwear"),
        row("cleavage", "exposure"),
        row("bikini", "attire"),
        row("red_bikini", "attire"),
        row("ring", "accessories", "usual"),
      ]),
    ).toBe("Red bikini + shell necklace");
  });
  it("uses usual tags only when the image has none, and skips struck ones", () => {
    expect(suggestOutfitName([row("hat", "headwear", "usual"), row("coat", "attire", "usual")])).toBe("Coat + hat");
    expect(suggestOutfitName([{ ...row("coat", "attire"), struck: true }, row("hat", "headwear")])).toBe("Hat");
  });
  it("is empty with nothing to name it by", () => {
    expect(suggestOutfitName([row("midriff", "exposure"), row("odd", null)])).toBe("");
  });
});

describe("save dialog", () => {
  const tag = (t: string): OutfitTag => ({ tag: t, group: "attire", checkable: true });
  const saved: Outfit = {
    _id: "o1",
    name: "Coat",
    character: "a",
    shared: true,
    tags: [tag("coat")],
    image_id: "L:1.png",
    thumb_url: null,
    hidden: false,
  };
  const dflt: Outfit = {
    ...saved,
    _id: "default",
    name: "Default",
    shared: false,
    chips: [
      { ...tag("coat"), dropped: true, added: false },
      { ...tag("hat"), dropped: false, added: true },
    ],
  };

  it("tells the four modes apart", () => {
    expect(outfitModeOf(undefined, "L:1.png")).toBe("from-image");
    expect(outfitModeOf(undefined, null)).toBe("blank");
    expect(outfitModeOf(saved, "L:1.png")).toBe("edit");
    expect(outfitModeOf(dflt, null)).toBe("default");
  });

  it("seeds each mode from its own data", () => {
    expect(seedOutfit("edit", { outfit: saved })).toEqual({
      name: "Coat",
      shared: true,
      rows: [{ ...tag("coat"), source: "image" }],
      cover: "L:1.png",
    });
    // An unrenamed Default starts with no name; struck and added chips keep their marks.
    expect(seedOutfit("default", { outfit: dflt })).toMatchObject({
      name: "",
      rows: [
        { tag: "coat", source: "image", struck: true },
        { tag: "hat", source: "added", struck: false },
      ],
    });
    expect(seedOutfit("blank", { usual: saved })).toEqual({
      name: "",
      shared: false,
      cover: null,
      rows: [{ ...tag("coat"), source: "usual" }],
    });
    const prefill = { image_id: "L:2.png", character: "a", tags: [{ ...tag("hat"), source: "image" as const }] };
    const fromImage = seedOutfit("from-image", { prefill });
    expect(fromImage.rows).toEqual([{ ...tag("hat"), source: "image" }]);
    expect("cover" in fromImage).toBe(false);
    expect(seedOutfit("from-image", {}).rows).toEqual([]);
  });

  const state = {
    character: "a",
    imageId: null,
    name: " Mine ",
    shownName: " Mine ",
    rows: [
      { ...tag("coat"), source: "image" as const, struck: true },
      { ...tag("hat"), source: "added" as const },
    ],
    shared: false,
    cover: "L:1.png",
  };

  it("patches a Default, sending the cover only when it changed", () => {
    expect(outfitSavePlan("default", { ...state, outfit: dflt })).toEqual({
      kind: "default",
      body: { name: "Mine", dropped: ["coat"], added: ["hat"] },
    });
    expect(outfitSavePlan("default", { ...state, outfit: dflt, cover: null }).body).toMatchObject({ image_id: null });
  });

  it("updates a saved outfit, or creates one on the image it came from", () => {
    expect(outfitSavePlan("edit", { ...state, outfit: saved })).toEqual({
      kind: "update",
      id: "o1",
      body: { name: "Mine", tags: ["coat", "hat"], shared: false },
    });
    expect(outfitSavePlan("edit", { ...state, outfit: saved, cover: "L:3.png" }).body).toMatchObject({ image_id: "L:3.png" });
    expect(outfitSavePlan("from-image", { ...state, imageId: "L:2.png" })).toEqual({
      kind: "create",
      body: { name: "Mine", tags: ["coat", "hat"], shared: false, character: "a", image_id: "L:2.png" },
    });
    expect(outfitSavePlan("blank", state).body).toMatchObject({ image_id: "L:1.png" });
  });
});
