import { describe, expect, it } from "vitest";
import { rejectedFields, samplingLabel } from "./sampling";
import type { NodeError } from "./generate";

describe("sampling", () => {
  it("labels a sampler as people write it", () => {
    expect(samplingLabel({ sampler: "euler_ancestral", scheduler: "normal", steps: 28, cfg: 6 })).toBe("euler a · 28 steps · CFG 6");
    expect(samplingLabel({ sampler: "dpmpp_2m", scheduler: "karras" })).toBe("dpmpp 2m karras");
    expect(samplingLabel({ steps: 20 })).toBe("20 steps");
    expect(samplingLabel({ sampler: "euler", steps: 28, cfg: 6.5 }, true)).toBe("euler · 28 · 6.5");
  });
});

it("rejectedFields picks the checkpoint and LoRA names", () => {
  const errs = [{ field: "checkpoint" }, { field: "lora", lora_name: "x.safetensors" }, { field: null }] as NodeError[];
  const r = rejectedFields(errs);
  expect(r.checkpoint).toBe(true);
  expect([...r.loras]).toEqual(["x.safetensors"]);
});
