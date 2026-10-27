import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCKS, DEFAULT_FORM } from "./generateForm";
import { loadDraft, validBlocks } from "./generateDraft";

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
