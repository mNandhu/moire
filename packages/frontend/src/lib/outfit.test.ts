import { describe, expect, it } from "vitest";
import { addWorn, keepPicked, outfitInput, pickFromInput, pickOf, toggleWorn, validOutfits, wornTags } from "./outfit";
import { formFromBatch, loadDraft, previewText } from "./generateForm";
import type { BatchInputs } from "./generate";

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
