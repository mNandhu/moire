import { describe, expect, it } from "vitest";
import {
  replaceCharacter,
  DEFAULT_BLOCKS,
  DEFAULT_FORM,
  formFromBatch,
  insertBlock,
  loadDraft,
  previewText,
  rejectedFields,
  samplingLabel,
  samplingOf,
  removeBlock,
  toParts,
  toQueueBody,
  validBlocks,
  type GenerateForm,
} from "./generateForm";
import type { BatchInputs, LoraPreset, NodeError, Preset } from "./generate";

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

describe("loadDraft", () => {
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

describe("sampling", () => {
  it("labels a sampler as people write it", () => {
    expect(samplingLabel({ sampler: "euler_ancestral", scheduler: "normal", steps: 28, cfg: 6 })).toBe("euler a · 28 steps · CFG 6");
    expect(samplingLabel({ sampler: "dpmpp_2m", scheduler: "karras" })).toBe("dpmpp 2m karras");
    expect(samplingLabel({ steps: 20 })).toBe("20 steps");
    expect(samplingLabel({ sampler: "euler", steps: 28, cfg: 6.5 }, true)).toBe("euler · 28 · 6.5");
  });
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

it("rejectedFields picks the checkpoint and LoRA names", () => {
  const errs = [{ field: "checkpoint" }, { field: "lora", lora_name: "x.safetensors" }, { field: null }] as NodeError[];
  const r = rejectedFields(errs);
  expect(r.checkpoint).toBe(true);
  expect([...r.loras]).toEqual(["x.safetensors"]);
});

describe("formFromBatch", () => {
  const base = {
    base: "b",
    extra: ["x"],
    negative_base: "n",
    negative_extra: [],
    checkpoint: "c.safetensors",
    loras: [{ name: "l", strength: 0.5 }],
    width: 1024,
    height: 1024,
    seed: { mode: "fixed", value: 5 },
    count: 8,
    per_request: 2,
    positive_text: "b, x",
    negative_text: "n",
  } as BatchInputs;

  it("brings an old batch's text back as the Prompt", () => {
    const f = formFromBatch(base, null);
    expect(f).toMatchObject({ prompt: "b, x", negative: "n", count: 8, seed: { mode: "fixed", value: 5 }, name: null });
  });

  it("brings back every character, or the one an older batch had", () => {
    const one = { tag: "a", label: "A", tags: ["a"], lora: null };
    const two = { tag: "b", label: "B", tags: ["b"], lora: null };
    expect(formFromBatch({ ...base, character: one, characters: [one, two] }, null).characters).toEqual(["a", "b"]);
    expect(formFromBatch({ ...base, character: one }, null).characters).toEqual(["a"]);
  });

  it("restores a layered batch's composer", () => {
    const sent = toQueueBody({ ...DEFAULT_FORM, prompt: "swing", prefix: { id: "q", text: "t" } }, "builtin", [], presets);
    const f = formFromBatch({ ...base, composer: sent.composer }, "Mine");
    expect(f).toMatchObject({ prompt: "swing", prefix: { id: "q", text: "t" }, name: "Mine" });
  });
});
