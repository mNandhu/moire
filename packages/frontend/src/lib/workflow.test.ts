import { describe, expect, it } from "vitest";
import type { Generator, QueueBody } from "./generate";
import { countModeOf, defaultBatchSize, forWorkflow, runBarOf, testState, workflowLine, workflowOptions } from "./workflow";

const gen = (over: Partial<Generator> = {}): Generator => ({
  _id: "g1",
  name: "Portrait detailer",
  kind: "custom",
  ready: true,
  slots: { positive: ["14", "text"], negative: ["13", "text"], batch_size: ["25", "batch_size"], per_request: 4 },
  sampling: { steps: 40 },
  source: { kind: "image", image_id: "L:a.png", family: "f", family_name: "Portraits", workflow_sig: "s" },
  defaults: { base: "1girl", negative: "bad" },
  fixed: { checkpoint: "noob.safetensors", size: "2:3 [832x1216 portrait]" },
  test: null,
  ...over,
});

describe("runBarOf", () => {
  it("offers controls only where the workflow has slots", () => {
    expect(runBarOf(gen())).toEqual({ checkpoint: false, size: false, sampling: true, batchSize: true, loras: false });
    const all = gen({ slots: { checkpoint: ["4", "ckpt_name"], width: ["5", "width"], height: ["5", "height"], lora_model: ["4", 0] } });
    expect(runBarOf(all)).toMatchObject({ checkpoint: true, size: true, batchSize: false, loras: true });
    // LoRAs written into the prompt (a remote workflow) still take the picker.
    expect(runBarOf(gen({ slots: { lora_text: true } })).loras).toBe(true);
  });
  it("keeps everything while the list is loading", () => {
    expect(runBarOf(undefined)).toEqual({ checkpoint: true, size: true, sampling: false, batchSize: false, loras: true });
  });
});

describe("count", () => {
  it("is images at the workflow's batch size, or the user's", () => {
    expect(countModeOf(gen(), null, 1)).toEqual({ kind: "images", perRequest: 4 });
    expect(countModeOf(gen(), 2, 1)).toEqual({ kind: "images", perRequest: 2 });
    expect(countModeOf(gen({ kind: "builtin" }), null, 3)).toEqual({ kind: "images", perRequest: 3 });
    expect(countModeOf(gen({ slots: {} }), null, 1)).toEqual({ kind: "runs" });
    // Still loading: the built-in, which counts images.
    expect(countModeOf(undefined, null, 2)).toEqual({ kind: "images", perRequest: 2 });
    expect(defaultBatchSize(gen(), 1)).toBe(4);
    expect(defaultBatchSize(gen({ kind: "builtin" }), 2)).toBe(2);
  });
});

it("forWorkflow drops what the workflow sets itself", () => {
  const body = {
    generator_id: "g1",
    checkpoint: "a.safetensors",
    width: 832,
    height: 1216,
    per_request: 2,
    loras: [{ name: "x", strength: 1 }],
    characters: [{ tag: "t", label: "T", tags: [], lora: { name: "c", strength: 1 } }],
  } as unknown as QueueBody;
  const out = forWorkflow(body, runBarOf(gen()));
  expect(out).toMatchObject({ checkpoint: null, width: null, height: null, per_request: 2, loras: [] });
  expect(out.characters[0].lora).toBeNull();
  expect(forWorkflow(body, runBarOf(undefined))).toEqual({ ...body, per_request: null });
});

it("testState", () => {
  expect(testState(gen())).toBe("ready");
  expect(testState(gen({ ready: false }))).toBe("untested");
  const t = { batch_id: 1, error: null, progress: null, outputs: 0, image_id: null };
  expect(testState(gen({ ready: false, test: { ...t, state: "running" } }))).toBe("running");
  expect(testState(gen({ ready: false, test: { ...t, state: "lost" } }))).toBe("failed");
});

it("options put the chosen one first, with a line on where it came from", () => {
  const b = gen({ _id: "builtin", name: "Built-in", kind: "builtin", source: null });
  const u = gen({ _id: "g2", name: "flux", source: { kind: "upload", filename: "flux.json" } });
  expect(workflowOptions([b, gen(), u], "g2").map((o) => [o.value, o.detail])).toEqual([
    ["g2", "flux.json"],
    ["builtin", "txt2img"],
    ["g1", "From Portraits"],
  ]);
  expect(workflowLine(gen({ name: "Portraits" }))).toBeUndefined();
});

it("a test that made images but none reached the library waits, one that made none failed", () => {
  const t = { batch_id: 1, error: null, progress: null, image_id: null };
  expect(testState(gen({ ready: false, test: { ...t, state: "done", outputs: 2 } }))).toBe("waiting");
  expect(testState(gen({ ready: false, test: { ...t, state: "done", outputs: 0 } }))).toBe("failed");
});
