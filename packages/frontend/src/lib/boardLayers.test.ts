import { describe, expect, it } from "vitest";
import { boardLayersOf } from "./boardLayers";
import { DEFAULT_FORM, type GenerateForm } from "./generateForm";
import type { PromptPart, Recipe } from "./generate";

const recipe = {
  tag: "hu_tao",
  identity: [
    { tag: "red_eyes", dropped: false, added: false },
    { tag: "twintails", dropped: true, added: false },
  ],
} as Recipe;

const parts: PromptPart[] = [
  { kind: "text", role: "prefix", label: "", text: "masterpiece" },
  { kind: "character" },
  { kind: "text", role: "prompt", text: "swing" },
  { kind: "text", role: "preset", label: "Mood", text: "smile" },
  { kind: "text", role: "text", text: "  " },
];

/** The layers over a local form, `edit` applying to it as setForm would. */
function board(start: GenerateForm) {
  let form = start;
  const edit = (fn: (f: GenerateForm) => GenerateForm) => {
    form = fn(form);
  };
  return { layers: boardLayersOf(parts, [recipe, undefined], [], start, edit), form: () => form };
}

describe("boardLayersOf", () => {
  const start: GenerateForm = {
    ...DEFAULT_FORM,
    characters: ["hu_tao"],
    outfits: { hu_tao: { id: "o1", name: "Coat", tags: ["coat"], dropped: [] } },
  };

  it("names the text layers other than the Prompt, then each loaded character", () => {
    const { layers } = board(start);
    expect(layers.map((l) => [l.key, l.label])).toEqual([
      ["part:0", "Prefix"],
      ["part:3", "Mood"],
      ["character:hu_tao", "hu tao"],
    ]);
    expect(layers[2].tags!.map((t) => t.tag)).toEqual(["hu_tao", "red_eyes", "coat"]);
  });

  it("toggles a tag where the layer keeps it", () => {
    const b = board(start);
    const tags = b.layers[2].tags!;
    tags[1].onToggle!();
    expect(b.form().identityOff).toEqual({ hu_tao: ["red_eyes"] });
    tags[2].onToggle!();
    expect(b.form().outfits.hu_tao.dropped).toEqual(["coat"]);
  });

  it("strikes several tags in one edit and undoes them", () => {
    const b = board(start);
    const undo = b.layers[2].onStrike!(["red_eyes", "coat"]);
    expect(b.form().identityOff).toEqual({ hu_tao: ["red_eyes"] });
    expect(b.form().outfits.hu_tao.dropped).toEqual(["coat"]);
    undo();
    expect(b.form().identityOff).toEqual({ hu_tao: [] });
    expect(b.form().outfits.hu_tao.dropped).toEqual([]);
  });
});
