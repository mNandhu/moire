import { describe, expect, it } from "vitest";
import type { GeneratorSetup, SeedGroup, TextInput } from "./generate";
import { canSave, checklist, defaultName, groupTicked, pickPrompt, pickerOptions, tickGroup } from "./generatorSetup";

const input = (over: Partial<TextInput>): TextInput => ({
  path: ["1", "text"],
  class_type: "CLIPTextEncode",
  title: "Positive",
  text: "1girl",
  replaces_link: false,
  reaches: "positive",
  ...over,
});

const setup = (over: Partial<GeneratorSetup> = {}): GeneratorSetup => ({
  slots: {},
  proposed: {},
  found: { sampler: { node: "3", title: "KSampler" } },
  text_inputs: [
    input({ path: ["7", "text"], title: "Negative", reaches: "negative" }),
    input({ path: ["6", "text"] }),
    input({ path: ["31", "wildcard"], title: "FaceDetailer", reaches: null }),
  ],
  seeds: [],
  outputs: [{ node: "9", title: "Save Image", saves: true, prefix: "out" }],
  input_images: [],
  source: { kind: "image", image_id: "L:a.png", family: "f", family_name: "Portrait", workflow_sig: "s" },
  defaults: { base: "", negative: "" },
  offer: [],
  base_without: "",
  problems: [],
  ...over,
});

describe("pickerOptions", () => {
  it("lists what reaches the side first and dims the rest with why", () => {
    const opts = pickerOptions(setup(), "positive");
    expect(opts.map((o) => [o.label, o.dim, o.hint])).toEqual([
      ["Positive", false, undefined],
      ["Negative", true, "Feeds the negative"],
      ["FaceDetailer", true, "Not used by the sampler"],
    ]);
    expect(opts[0].group).toBe("Reach the sampler's positive");
    expect(opts[1].group).toBe("Other text inputs");
  });

  it("lists everything plainly without a sampler", () => {
    const opts = pickerOptions(setup({ found: { sampler: null } }), "negative");
    expect(opts.every((o) => !o.dim && o.group === "Text inputs")).toBe(true);
  });

  it("marks a joined input", () => {
    const s = setup({ text_inputs: [input({ path: ["11", "text"], replaces_link: true })] });
    expect(pickerOptions(s, "positive")[0].detail).toBe("#11 text, joined");
  });
});

describe("pickPrompt", () => {
  it("overwrites a link only for a joined input", () => {
    const joined = pickPrompt({}, "positive", input({ path: ["11", "text"], replaces_link: true }));
    expect(joined).toMatchObject({ positive: ["11", "text"], replace_links: ["positive"] });
    const plain = pickPrompt(joined, "positive", input({ path: ["50", "text"] }));
    expect(plain).toMatchObject({ positive: ["50", "text"], replace_links: [] });
  });
});

describe("seed groups", () => {
  const g: SeedGroup = {
    value: 1,
    inputs: [
      { path: ["3", "seed"], value: 1, used_by: [] },
      { path: ["31", "seed"], value: 1, used_by: [] },
    ],
  };
  it("ticks and unticks a whole group, leaving others", () => {
    const on = tickGroup({ seeds: [["40", "seed"]] }, g, true);
    expect(groupTicked(on, g)).toBe(true);
    const off = tickGroup(on, g, false);
    expect(off.seeds).toEqual([["40", "seed"]]);
    expect(groupTicked(off, g)).toBe(false);
  });
});

describe("checklist", () => {
  it("blocks without prompts or a Save Image, notes the rest", () => {
    const items = checklist(setup({ outputs: [], input_images: [{ node: "72", title: "Load Image", image: "a.png" }] }), {});
    expect(items.map((i) => [i.label, i.ok])).toEqual([
      ["Positive prompt: choose a node", false],
      ["Negative prompt: choose a node", false],
      ["No Save Image node: add one in ComfyUI", false],
      ["No LoRA insertion point: LoRAs are off", true],
      ["No seed is randomized: every image repeats", true],
      ["Uses an input image: Load Image #72", true],
    ]);
    expect(canSave(items)).toBe(false);
  });

  it("is saveable with both prompts", () => {
    const items = checklist(setup(), {
      positive: ["6", "text"],
      negative: ["7", "text"],
      seeds: [["3", "seed"]],
      lora_model: ["4", 0],
    });
    expect(canSave(items)).toBe(true);
    expect(items.filter((i) => i.note)).toEqual([]);
  });
});

it("defaultName prefers the family, then the file", () => {
  expect(defaultName(setup())).toBe("Portrait");
  expect(defaultName(setup({ source: { kind: "upload", filename: "flow.json" } }))).toBe("flow");
  expect(defaultName(setup({ source: { kind: "upload", filename: null } }))).toBe("Workflow");
});
