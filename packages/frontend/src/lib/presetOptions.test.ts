import { describe, expect, it } from "vitest";
import { NEW, NONE, isDeletedPreset, presetChoice, presetOptions } from "./presetOptions";

const a = { _id: "a", name: "Soft", text: "soft light" };
const b = { _id: "b", name: "Hard", text: "hard light" };

describe("presetOptions", () => {
  it("lists None, the presets, then New", () => {
    const o = presetOptions([a, b], undefined, true);
    expect(o.map((x) => x.value)).toEqual([NONE, "a", "b", NEW]);
    expect(o[1]).toMatchObject({ label: "Soft", keywords: "soft light", detail: undefined });
  });

  it("can show each preset's text and what None means", () => {
    const o = presetOptions([a], undefined, true, { noneDetail: "LoRA only", showText: true });
    expect(o[0].detail).toBe("LoRA only");
    expect(o[1].detail).toBe("soft light");
  });

  it("fades a deleted preset still selected, once presets are loaded", () => {
    expect(presetOptions([a], "gone", true).map((x) => x.value)).toEqual([NONE, "a", "gone", NEW]);
    expect(presetOptions([a], "gone", true)[2]).toMatchObject({ label: "Deleted preset", dim: true });
    // Not loaded yet: the preset may just not have arrived.
    expect(presetOptions([], "gone", false).map((x) => x.value)).toEqual([NONE, NEW]);
    expect(isDeletedPreset([a], "a", true)).toBe(false);
    expect(isDeletedPreset([a], undefined, true)).toBe(false);
  });
});

describe("presetChoice", () => {
  it("reads the three kinds of pick", () => {
    expect(presetChoice([a], NONE)).toEqual({ none: true });
    expect(presetChoice([a], NEW)).toEqual({ create: true });
    expect(presetChoice([a], "a")).toEqual({ preset: a });
    expect(presetChoice([a], "zzz")).toBeUndefined();
  });
});
