import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCKS, DEFAULT_FORM, type GenerateForm } from "./generateForm";
import { loadDraft, rekeyCast, unescapeCast, validBlocks } from "./generateDraft";
import { MAX_CHARACTERS } from "./generationLimits";

const draft = (d: unknown) => loadDraft({ getItem: () => JSON.stringify(d) });

describe("layers", () => {
  it("rejects malformed stored layers", () => {
    expect(validBlocks([{ kind: "prompt" }])).toEqual(DEFAULT_BLOCKS);
    expect(validBlocks([...DEFAULT_BLOCKS, { kind: "text" }])).toEqual(DEFAULT_BLOCKS);
    expect(validBlocks("x")).toEqual(DEFAULT_BLOCKS);
    const ok = [...DEFAULT_BLOCKS, { kind: "text", id: "a", text: "t" }];
    expect(validBlocks(ok)).toEqual(ok);
  });

  it("adds Style after the Prompt to layers saved before it existed", () => {
    const old = [{ kind: "prefix" }, { kind: "prompt" }, { kind: "text", id: "a", text: "t" }, { kind: "character" }];
    expect(validBlocks(old).map((b) => b.kind)).toEqual(["prefix", "prompt", "style", "text", "character"]);
  });
});

describe("loadDraft", () => {
  it("keeps batch strikes only for characters still picked", () => {
    const f = draft({ characters: ["a"], identityOff: { a: ["x", "x", 3], b: ["y"] } });
    expect(f.identityOff).toEqual({ a: ["x"] });
    expect(draft({ characters: ["a"], identityOff: "junk" }).identityOff).toEqual({});
  });

  it("falls back to defaults on bad storage", () => {
    expect(loadDraft({ getItem: () => "not json" })).toEqual(DEFAULT_FORM);
    expect(
      loadDraft({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toEqual(DEFAULT_FORM);
    expect(loadDraft(null)).toEqual(DEFAULT_FORM);
  });

  it("keeps a draft's one character as the list", () => {
    expect(draft({ character: "nahida" }).characters).toEqual(["nahida"]);
    expect(draft({ characters: ["a", "b", "a", 3] }).characters).toEqual(["a", "b"]);
  });

  it("keeps known fields of the right type", () => {
    const d = draft({ prompt: "x", count: "9", checkpoint: "a.safetensors", prefix: { id: "q", text: "t" }, junk: 1 });
    expect(d.prompt).toBe("x");
    expect(d.count).toBe(DEFAULT_FORM.count);
    expect(d.checkpoint).toBe("a.safetensors");
    expect(d.prefix).toEqual({ id: "q", text: "t" });
    expect("junk" in d).toBe(false);
  });

  it("moves the old composer's Base and Extra into the Prompt", () => {
    const d = draft({ base: "sitting on a swing, garden", extra: ["red_dress"], negativeBase: "lowres", negativeExtra: [] });
    expect(d.prompt).toBe("sitting on a swing, garden, red_dress");
    expect(d.negative).toBe("lowres");
    expect(d.prefix).toBeNull();
    expect(d.blocks).toEqual(DEFAULT_BLOCKS);
  });
});

describe("loadDraft: prompt-escaped character keys", () => {
  it("unescapes a character picked under its escaped name, with its outfit", () => {
    const store = {
      getItem: () =>
        JSON.stringify({
          characters: ["yuzuriha_\\(jigokuraku\\)"],
          outfits: { "yuzuriha_\\(jigokuraku\\)": { id: "default", name: "Default", tags: ["kimono"] } },
        }),
    };
    const form = loadDraft(store);
    expect(form.characters).toEqual(["yuzuriha_(jigokuraku)"]);
    expect(Object.keys(form.outfits)).toEqual(["yuzuriha_(jigokuraku)"]);
  });

  it("counts two spellings of one character as one toward the limit", () => {
    const many = Array.from({ length: MAX_CHARACTERS - 1 }, (_, i) => `c${i}`);
    const store = { getItem: () => JSON.stringify({ characters: ["a_\\(b\\)", "a_(b)", ...many, "last"] }) };
    const form = loadDraft(store);
    expect(form.characters).toEqual(["a_(b)", ...many]);
    expect(form.characters).toHaveLength(MAX_CHARACTERS);
  });

  it("takes the LoRA switch along too", () => {
    const store = { getItem: () => JSON.stringify({ characters: ["a_\\(b\\)"], loraOff: ["a_\\(b\\)"] }) };
    expect(loadDraft(store).loraOff).toEqual(["a_(b)"]);
  });
});

describe("rekeyCast", () => {
  const pick = (name: string) => ({ id: name, name, tags: [name], dropped: [] });
  const f: GenerateForm = {
    ...DEFAULT_FORM,
    characters: ["old", "b"],
    outfits: { old: pick("o1"), b: pick("o2") },
    identityOff: { old: ["x"] },
    loraOff: ["old"],
    fresh: ["b"],
  };

  it("renames a character with what it wears, struck tags, LoRA switch and fresh mark", () => {
    const g = rekeyCast(f, (t) => (t === "old" ? "new" : t));
    expect(g.characters).toEqual(["new", "b"]);
    expect(g.outfits).toEqual({ new: pick("o1"), b: pick("o2") });
    expect(g.identityOff).toEqual({ new: ["x"] });
    expect(g.loraOff).toEqual(["new"]);
    expect(g.fresh).toEqual(["b"]);
  });

  it("two that become one keep the state of the one already under that name", () => {
    // "b" is another name of "old": old's own state stays.
    const g = rekeyCast(f, (t) => (t === "b" ? "old" : t));
    expect(g.characters).toEqual(["old"]);
    expect(g.outfits).toEqual({ old: pick("o1") });
    expect(g.loraOff).toEqual(["old"]);
    expect(g.fresh).toEqual([]);
    // "old" is another name of "b": b's state, in old's place.
    const h = rekeyCast({ ...f, characters: ["old", "c", "b"] }, (t) => (t === "old" ? "b" : t));
    expect(h.characters).toEqual(["b", "c"]);
    expect(h.outfits).toEqual({ b: pick("o2") });
    expect(h.identityOff).toEqual({});
    expect(h.loraOff).toEqual([]);
    expect(h.fresh).toEqual(["b"]);
  });

  it("is the same form when nothing moves", () => {
    expect(rekeyCast(f, (t) => t)).toBe(f);
    expect(unescapeCast(f)).toBe(f);
  });
});
