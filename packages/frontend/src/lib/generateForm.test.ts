import { describe, expect, it } from "vitest";
import { DEFAULT_FORM, loadDraft, rejectedFields, toQueueBody } from "./generateForm";
import type { NodeError } from "./generate";

describe("toQueueBody", () => {
  it("sends a fixed seed only when it has a value", () => {
    const body = toQueueBody({ ...DEFAULT_FORM, seed: { mode: "fixed", value: null } }, "builtin");
    expect(body.seed).toEqual({ mode: "random", value: null });
    expect(toQueueBody({ ...DEFAULT_FORM, seed: { mode: "fixed", value: 7 } }, "builtin").seed).toEqual({
      mode: "fixed",
      value: 7,
    });
  });
});

describe("loadDraft", () => {
  it("falls back to defaults on bad storage", () => {
    expect(loadDraft({ getItem: () => "not json" })).toEqual(DEFAULT_FORM);
    expect(loadDraft({ getItem: () => { throw new Error("blocked"); } })).toEqual(DEFAULT_FORM);
    expect(loadDraft(null)).toEqual(DEFAULT_FORM);
  });
  it("keeps known fields of the right type", () => {
    const d = loadDraft({ getItem: () => JSON.stringify({ base: "x", count: "9", checkpoint: "a.safetensors", junk: 1 }) });
    expect(d.base).toBe("x");
    expect(d.count).toBe(DEFAULT_FORM.count);
    expect(d.checkpoint).toBe("a.safetensors");
    expect("junk" in d).toBe(false);
  });
});

it("rejectedFields picks the checkpoint and LoRA names", () => {
  const errs = [
    { field: "checkpoint" },
    { field: "lora", lora_name: "x.safetensors" },
    { field: null },
  ] as NodeError[];
  const r = rejectedFields(errs);
  expect(r.checkpoint).toBe(true);
  expect([...r.loras]).toEqual(["x.safetensors"]);
});
