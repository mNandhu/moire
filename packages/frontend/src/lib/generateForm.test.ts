import { describe, expect, it } from "vitest";
import {
  replaceCharacter,
  DEFAULT_BLOCKS,
  DEFAULT_FORM,
  insertBlock,
  previewText,
  removeBlock,
  toParts,
  toEstimateBody,
  toQueueBody,
  type GenerateForm,
} from "./generateForm";
import { loadDraft } from "./generateDraft";
import { formFromBatch } from "./remixForm";
import { samplingLabel, samplingOf } from "./sampling";
import type { BatchInputs, LoraPreset, Preset } from "./generate";

const presets: Preset[] = [
  { _id: "q", name: "Quality", kind: "positive", text: "masterpiece, best quality", updated_at: 0 },
  { _id: "n", name: "Neg", kind: "negative", text: "lowres", updated_at: 0 },
];

const draft = (d: unknown) => loadDraft({ getItem: () => JSON.stringify(d) });

describe("toQueueBody", () => {
  it("sends a fixed seed only when it has a value", () => {
    const body = toQueueBody({ ...DEFAULT_FORM, seed: { mode: "fixed", value: null } }, "builtin", [], presets);
    expect(body.seed).toEqual({ mode: "random", value: null });
    expect(toQueueBody({ ...DEFAULT_FORM, seed: { mode: "fixed", value: 7 } }, "builtin", [], presets).seed).toEqual({
      mode: "fixed",
      value: 7,
    });
  });
});

describe("layers", () => {
  const form: GenerateForm = {
    ...DEFAULT_FORM,
    prefix: { id: "q", text: "old text" },
    prompt: "(smile:1.2), swing",
    negativePreset: { id: "gone", text: "bad hands" },
    negative: "blurry",
  };

  it("sends parts in layer order, presets at their current text", () => {
    let blocks = insertBlock(form.blocks, 2, "embedding");
    const emb = blocks[2] as { id: string };
    blocks = blocks.map((b) => ("id" in b && b.id === emb.id ? { ...b, name: "pos/aesthetic" } : b));
    const { positive, negative } = toParts({ ...form, blocks }, presets);
    expect(positive).toEqual([
      { kind: "text", role: "prefix", label: "Quality", text: "masterpiece, best quality" },
      { kind: "character" },
      { kind: "embedding", name: "pos/aesthetic" },
      { kind: "text", role: "prompt", text: "(smile:1.2), swing" },
    ]);
    // A deleted preset still sends the text it had when picked.
    expect(negative[0]).toMatchObject({ text: "bad hands" });
    expect(previewText(positive, [["hu_tao_(genshin_impact)"]])).toBe(
      "masterpiece, best quality, hu_tao_\\(genshin_impact\\), embedding:pos/aesthetic, (smile:1.2), swing",
    );
    expect(removeBlock(blocks, emb.id)).toEqual(DEFAULT_BLOCKS);
  });
});

describe("style LoRAs", () => {
  const loraPresets: LoraPreset[] = [
    { _id: "g", stem: "niji", name: "glitch", text: "0__11Xx_illu, glitch", strength: 0.6, updated_at: 0 },
  ];
  const form: GenerateForm = {
    ...DEFAULT_FORM,
    prompt: "swing",
    loras: [
      { name: "niji.safetensors", strength: 0.6, preset: { id: "g", text: "old" } },
      { name: "detail.safetensors", strength: 0.5, preset: null },
      { name: "gone.safetensors", strength: 1, preset: { id: "x", text: "flat color" } },
    ],
  };

  it("sends each LoRA's words where the Style layer sits, and the LoRAs without presets", () => {
    const body = toQueueBody(form, "builtin", [], presets, loraPresets);
    expect(body.positive.slice(-2)).toEqual([
      { kind: "text", role: "prompt", text: "swing" },
      { kind: "text", role: "style", text: "0__11Xx_illu, glitch, flat color" },
    ]);
    expect(body.loras[0]).toEqual({ name: "niji.safetensors", strength: 0.6 });
  });

  it("brings the presets back with the batch", () => {
    const sent = toQueueBody(form, "builtin", [], presets, loraPresets);
    const f = formFromBatch({ ...({} as BatchInputs), ...sent, seed: sent.seed, composer: sent.composer } as BatchInputs, null);
    expect(f.loras.map((l) => l.preset?.id ?? null)).toEqual(["g", null, "x"]);
  });

  it("brings a character's batch-only strikes back with the batch", () => {
    const struck = { ...form, characters: ["a"], identityOff: { a: ["red_eyes"] } };
    const sent = toQueueBody(struck, "builtin", [{ tag: "a", label: "A", tags: ["a"], lora: null }], presets, loraPresets);
    const f = formFromBatch({ ...({} as BatchInputs), ...sent, seed: sent.seed, composer: sent.composer } as BatchInputs, null);
    expect(f.identityOff).toEqual({ a: ["red_eyes"] });
  });

  it("keeps a draft's presets", () => {
    expect(draft({ loras: form.loras }).loras).toEqual(form.loras);
  });
});

it("replaceCharacter changes, removes, and never shows a tag twice", () => {
  expect(replaceCharacter(["a", "b", "c"], 1, "x")).toEqual(["a", "x", "c"]);
  expect(replaceCharacter(["a", "b", "c"], 1, null)).toEqual(["a", "c"]);
  // Picking "a" on row 2 moves it there.
  expect(replaceCharacter(["a", "b", "c"], 2, "a")).toEqual(["b", "a"]);
});

describe("sampling", () => {
  it("round-trips through the queue body, a batch and the draft", () => {
    const form = { ...DEFAULT_FORM, sampling: { sampler: "dpmpp_2m", steps: 20 } };
    const sent = toQueueBody(form, "builtin", [], presets);
    expect(sent.sampling).toEqual({ sampler: "dpmpp_2m", steps: 20 });
    const f = formFromBatch({ ...({} as BatchInputs), ...sent, seed: sent.seed } as BatchInputs, null);
    expect(f.sampling).toEqual({ sampler: "dpmpp_2m", steps: 20 });
    expect(draft({ sampling: { steps: 20, cfg: "x", junk: 1 } }).sampling).toEqual({ steps: 20 });
    expect(samplingOf({ steps: 20.5, cfg: 31 })).toEqual({});
    expect(samplingLabel({ scheduler: "sgm_uniform" })).toBe("sgm uniform scheduler");
    expect(draft({}).sampling).toEqual({});
    expect(toQueueBody({ ...DEFAULT_FORM, perRequest: 2 }, "builtin", [], presets).per_request).toBe(2);
    expect(draft({ perRequest: 3 }).perRequest).toBe(3);
    expect(draft({ perRequest: 100 }).perRequest).toBeNull();
    const back = formFromBatch({ ...({} as BatchInputs), ...sent, per_request: 2, per_request_asked: null } as BatchInputs, null);
    expect(back.perRequest).toBeNull();
    expect(samplingOf(null)).toEqual({});
  });
});


describe("toEstimateBody", () => {
  it("keeps only what decides how long a batch takes", () => {
    const f = { ...DEFAULT_FORM, prompt: "1girl", count: 6, perRequest: 2, checkpoint: "a.safetensors" };
    expect(toEstimateBody(f, "builtin")).toEqual({
      generator_id: "builtin",
      checkpoint: "a.safetensors",
      sampling: DEFAULT_FORM.sampling,
      width: DEFAULT_FORM.width,
      height: DEFAULT_FORM.height,
      count: 6,
      per_request: 2,
    });
  });
});
