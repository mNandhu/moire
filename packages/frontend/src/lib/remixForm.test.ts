import { describe, expect, it } from "vitest";
import { DEFAULT_FORM, formFromRemix, loadDraft } from "./generateForm";
import type { BatchInputs, Generator, RemixDoc } from "./generate";

const builtin: Generator = {
  _id: "builtin",
  name: "Built-in",
  kind: "builtin",
  ready: true,
  slots: {},
  sampling: { sampler: "euler", steps: 28 },
  source: null,
  defaults: null,
  fixed: { checkpoint: null, size: null },
  checkpoint_default: null,
  test: null,
};

const custom: Generator = {
  ...builtin,
  _id: "g1",
  name: "Portrait",
  kind: "custom",
  slots: { positive: ["1", "text"], negative: ["2", "text"] },
  sampling: { steps: 40 },
};

const doc: RemixDoc = {
  image_id: "L1:a.png",
  source: "comfyui",
  workflow: { family: "fam", family_name: "Portrait", file_name: null, workflow_sig: "s" },
  prompt: "maid, smile",
  negative: "lowres",
  characters: ["furina"],
  seed: 42,
  width: 832,
  height: 1216,
  sampling: { sampler: "euler", steps: 30, cfg: 5 },
  checkpoint: "noob.safetensors",
  loras: [{ name: "flat.safetensors", strength: 0.7, installed: true }],
  batch: null,
};

const current = { ...DEFAULT_FORM, checkpoint: "mine.safetensors", width: 1024, height: 1024, prompt: "old" };

describe("formFromRemix", () => {
  it("takes everything with the built-in", () => {
    const f = formFromRemix(doc, builtin, "same", current);
    expect(f.workflow).toBe("builtin");
    expect(f.prompt).toBe("maid, smile");
    expect(f.negative).toBe("lowres");
    expect(f.characters).toEqual(["furina"]);
    expect(f.checkpoint).toBe("noob.safetensors");
    expect([f.width, f.height]).toEqual([832, 1216]);
    expect(f.sampling).toEqual({ sampler: "euler", steps: 30, cfg: 5 });
    expect(f.loras).toEqual([{ name: "flat.safetensors", strength: 0.7, preset: null }]);
    expect(f.seed).toEqual({ mode: "fixed", value: 42 });
    expect(f.count).toBe(1);
    expect(f.remix).toEqual({ image: "L1:a.png", seed: 42 });
  });

  it("leaves a custom workflow its own LoRAs, checkpoint, size and sampling", () => {
    const f = formFromRemix(doc, custom, "new", current);
    expect(f.loras).toEqual([]);
    expect(f.checkpoint).toBe("mine.safetensors");
    expect([f.width, f.height]).toEqual([1024, 1024]);
    expect(f.sampling).toEqual({ steps: 30 });
    expect(f.seed).toEqual({ mode: "random", value: null });
    expect(f.remix).toEqual({ image: "L1:a.png", seed: null });
  });

  it("takes the image's checkpoint only into its own workflow, else the workflow's default", () => {
    const anima = { ...custom, slots: { ...custom.slots, checkpoint: ["86", "value"] }, checkpoint_default: "anima.safetensors" } as Generator;
    expect(formFromRemix(doc, anima, "new", current, true).checkpoint).toBe("noob.safetensors");
    expect(formFromRemix(doc, anima, "new", current).checkpoint).toBe("anima.safetensors");
    expect(formFromRemix(doc, { ...anima, checkpoint_default: null }, "new", current).checkpoint).toBe("mine.safetensors");
  });

  it("keeps the draft's checkpoint when ComfyUI lacks the image's", () => {
    expect(formFromRemix({ ...doc, checkpoint: null }, builtin, "new", current).checkpoint).toBe("mine.safetensors");
  });

  it("replays a Moiré batch with its own workflow, the whole request on the same seed", () => {
    const inputs = {
      base: "",
      extra: [],
      negative_base: "",
      negative_extra: [],
      checkpoint: "c",
      loras: [],
      width: 832,
      height: 1216,
      seed: { mode: "random", value: null },
      count: 8,
      per_request: 2,
      per_request_asked: 2,
      composer: { v: 2, prompt: "from batch", blocks: [] },
      positive_text: "",
      negative_text: "",
    } as unknown as BatchInputs;
    const batch = { id: 1, name: "B", auto_name: true, generator_id: "builtin", inputs, seed: 9, images: 2, index: 1 };
    const f = formFromRemix({ ...doc, batch }, builtin, "same", current);
    expect(f.prompt).toBe("from batch");
    expect(f.seed).toEqual({ mode: "fixed", value: 9 });
    expect(f.count).toBe(2);
    expect(f.perRequest).toBe(2);
    expect(f.remix).toEqual({ image: "L1:a.png", seed: 9 });
    // Another workflow: the image's values instead.
    expect(formFromRemix({ ...doc, batch }, custom, "same", current).prompt).toBe("maid, smile");
  });
});

describe("draft remix", () => {
  it("round-trips and drops a malformed one", () => {
    const store = (v: unknown) => ({ getItem: () => JSON.stringify(v) });
    expect(loadDraft(store({ remix: { image: "L1:a.png", seed: 3 } })).remix).toEqual({ image: "L1:a.png", seed: 3 });
    expect(loadDraft(store({ remix: { image: 4 } })).remix).toBeNull();
  });
});
