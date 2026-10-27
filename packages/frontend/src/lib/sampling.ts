/** Sampling settings: reading a stored value, and their labels. */
import type { NodeError, Sampling } from "./generate";
import { CFG_RANGE, STEPS_RANGE } from "./generationLimits";

const isStr = (v: unknown): v is string => typeof v === "string";

/** The sampling settings a stored value holds, the rest dropped. Pure. */
export function samplingOf(v: unknown): Sampling {
  if (!v || typeof v !== "object") return {};
  const d = v as Record<string, unknown>;
  const out: Sampling = {};
  if (isStr(d.sampler)) out.sampler = d.sampler;
  if (isStr(d.scheduler)) out.scheduler = d.scheduler;
  // The backend's limits; anything else is left to the Generator.
  if (Number.isInteger(d.steps) && (d.steps as number) >= STEPS_RANGE[0] && (d.steps as number) <= STEPS_RANGE[1]) out.steps = d.steps as number;
  if (typeof d.cfg === "number" && d.cfg >= CFG_RANGE[0] && d.cfg <= CFG_RANGE[1]) out.cfg = d.cfg;
  return out;
}

/** A sampler as people write it: "euler a", "dpmpp 2m karras". Pure. */
export function samplerLabel(sampler: string, scheduler?: string): string {
  const name = sampler.replace(/_ancestral$/, " a").replace(/_/g, " ");
  return scheduler && scheduler !== "normal" ? `${name} ${scheduler.replace(/_/g, " ")}` : name;
}

/** "euler a · 28 steps · CFG 6" (`short`: "euler a · 28 · 6"), from
 * whichever settings are given. Pure. */
export function samplingLabel(s: Sampling, short = false): string {
  return [
    s.sampler ? samplerLabel(s.sampler, s.scheduler) : s.scheduler && `${s.scheduler.replace(/_/g, " ")} scheduler`,
    s.steps != null && (short ? `${s.steps}` : `${s.steps} steps`),
    s.cfg != null && (short ? `${s.cfg}` : `CFG ${s.cfg}`),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a rejection flags: the checkpoint, sampling, and which LoRA names. */
export function rejectedFields(errors: readonly NodeError[]): { checkpoint: boolean; sampling: boolean; loras: Set<string> } {
  return {
    checkpoint: errors.some((e) => e.field === "checkpoint"),
    sampling: errors.some((e) => e.field === "sampling"),
    loras: new Set(errors.filter((e) => e.field === "lora" && e.lora_name).map((e) => e.lora_name!)),
  };
}
