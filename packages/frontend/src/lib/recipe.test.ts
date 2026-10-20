import { describe, expect, it } from "vitest";
import type { Recipe } from "./generate";
import { characterInput, characterTags, toggleDropped } from "./recipe";

const recipe: Recipe = {
  tag: "hu_tao_(genshin_impact)",
  aliases: ["hu_tao"],
  count: 12,
  identity_images: 12,
  identity: [
    { tag: "red_eyes", dropped: false, added: false },
    { tag: "smile", dropped: true, added: false },
    { tag: "fang", dropped: false, added: true },
  ],
  outfit: ["porkpie_hat"],
  lora: { stem: "hu_tao_v2", file: "chars/hu_tao_v2.safetensors", strength: 0.8, images: 4 },
  lora_edited: false,
  strength_edited: false,
  candidates: [],
};

describe("recipe", () => {
  it("writes the character tag and the kept identity tags", () => {
    expect(characterTags(recipe)).toEqual(["hu_tao_(genshin_impact)", "red_eyes", "fang"]);
  });

  it("sends the installed file, or no LoRA when it isn't installed", () => {
    expect(characterInput(recipe, "Hu Tao")).toEqual({
      tag: "hu_tao_(genshin_impact)",
      label: "Hu Tao",
      tags: ["hu_tao_(genshin_impact)", "red_eyes", "fang"],
      lora: { name: "chars/hu_tao_v2.safetensors", strength: 0.8 },
    });
    const missing = { ...recipe, lora: { ...recipe.lora!, file: null } };
    expect(characterInput(missing, "Hu Tao").lora).toBeNull();
  });

  it("toggles a drop", () => {
    expect(toggleDropped(recipe, "red_eyes")).toEqual(["red_eyes", "smile"]);
    expect(toggleDropped(recipe, "smile")).toEqual([]);
  });
});
