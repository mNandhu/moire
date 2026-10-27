import { describe, expect, it } from "vitest";
import { DEFAULT_FORM, type GenerateForm } from "./generateForm";
import {
  setCharacters,
  setOutfitPick,
  settleFresh,
  strikeCharacter,
  switchWorkflow,
  toggleIdentityOff,
  undoStrike,
} from "./composerEdits";
import type { Generator } from "./generate";
import type { OutfitPick } from "./outfit";

const dress: OutfitPick = { id: "o1", name: "Dress", tags: ["red_dress", "hat"], dropped: [] };

describe("setOutfitPick", () => {
  it("wears the pick or nothing, and settles the character", () => {
    const f: GenerateForm = { ...DEFAULT_FORM, characters: ["a"], fresh: ["a"] };
    const on = setOutfitPick(f, "a", dress);
    expect(on.outfits).toEqual({ a: dress });
    expect(on.fresh).toEqual([]);
    expect(setOutfitPick(on, "a", null).outfits).toEqual({});
  });
});

describe("setCharacters", () => {
  it("drops what the others wore and struck, and marks the new one fresh", () => {
    const f: GenerateForm = {
      ...DEFAULT_FORM,
      characters: ["a", "b"],
      outfits: { a: dress, b: dress },
      identityOff: { a: ["x"], b: ["y"] },
      fresh: ["b"],
    };
    const next = setCharacters(f, ["a", "c"]);
    expect(next.characters).toEqual(["a", "c"]);
    expect(next.outfits).toEqual({ a: dress });
    expect(next.identityOff).toEqual({ a: ["x"] });
    expect(next.fresh).toEqual(["c"]);
  });
});

describe("settleFresh", () => {
  const f: GenerateForm = { ...DEFAULT_FORM, characters: ["a", "b"], fresh: ["a", "b"], outfits: { b: dress } };

  it("starts a fresh character in the pick", () => {
    const next = settleFresh(f, "a", dress);
    expect(next.fresh).toEqual(["b"]);
    expect(next.outfits).toEqual({ a: dress, b: dress });
  });

  it("keeps an outfit chosen meanwhile, and leaves a settled one alone", () => {
    const other = { ...dress, id: "o2" };
    expect(settleFresh(f, "b", other).outfits.b).toBe(dress);
    const settled = settleFresh(f, "a", null);
    expect(settled.fresh).toEqual(["b"]);
    expect(settled.outfits).toEqual({ b: dress });
    expect(settleFresh(settled, "a", dress)).toBe(settled);
  });
});

describe("switchWorkflow", () => {
  const next = { defaults: { base: "1girl", negative: "bad" } } as Generator;

  it("drops the old graph's settings and fills an empty prompt", () => {
    const f: GenerateForm = { ...DEFAULT_FORM, sampling: { steps: 20 }, perRequest: 2, prompt: " ", negative: "mine" };
    const out = switchWorkflow(f, "g2", next);
    expect(out).toMatchObject({ workflow: "g2", sampling: {}, perRequest: null, prompt: "1girl", negative: "mine" });
    expect(switchWorkflow(f, "gone", undefined).prompt).toBe(" ");
  });
});

it("toggleIdentityOff strikes and brings back one identity tag", () => {
  const off = toggleIdentityOff(DEFAULT_FORM, "a", "red_eyes");
  expect(off.identityOff).toEqual({ a: ["red_eyes"] });
  expect(toggleIdentityOff(off, "a", "red_eyes").identityOff).toEqual({ a: [] });
});

describe("strikeCharacter", () => {
  const r = { tag: "a", identity: [{ tag: "red_eyes", dropped: false, added: false }] };
  const f: GenerateForm = { ...DEFAULT_FORM, characters: ["a"], outfits: { a: dress } };

  it("strikes identity and worn tags, and the undo brings them back", () => {
    const struck = strikeCharacter(f, r, ["red_eyes", "hat", "smile"]);
    expect(struck.identityOff).toEqual({ a: ["red_eyes"] });
    expect(struck.outfits.a.dropped).toEqual(["hat"]);
    const back = undoStrike(struck, r, ["red_eyes", "hat", "smile"], dress);
    expect(back.identityOff).toEqual({ a: [] });
    expect(back.outfits.a.dropped).toEqual([]);
  });

  it("leaves an outfit changed since the strike as it is", () => {
    const struck = strikeCharacter(f, r, ["hat"]);
    const other = { ...dress, id: "o2", dropped: ["hat"] };
    const swapped = { ...struck, outfits: { a: other } };
    expect(undoStrike(swapped, r, ["hat"], dress).outfits.a).toBe(other);
    expect(undoStrike(struck, r, ["hat"], undefined).outfits.a).toBe(struck.outfits.a);
  });
});
