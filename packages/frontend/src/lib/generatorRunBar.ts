import type { PickerOption } from "../components/ui";
import type { Generator, QueueBody } from "./generate";
import { workflowOrigin } from "./generatorSetup";
import type { CountMode } from "./requests";

/** The picker's pinned row value: opens setup instead of choosing. */
export const SET_UP = "\u0000set-up";

/** What the run bar offers for a workflow: a control where Moiré writes the
 * value, the workflow's own value read-only where it doesn't. */
export type RunBar = {
  checkpoint: boolean;
  size: boolean;
  sampling: boolean;
  /** Batch size per batch, beside Images. */
  batchSize: boolean;
  loras: boolean;
};

export function runBarOf(gen: Generator | undefined): RunBar {
  const s = gen?.slots ?? {};
  return {
    checkpoint: !gen || !!s.checkpoint,
    size: !gen || (!!s.width && !!s.height),
    sampling: Object.keys(gen?.sampling ?? {}).length > 0,
    batchSize: !!s.batch_size,
    loras: !gen || !!s.lora_model || !!s.lora_text,
  };
}

/** How the count splits: images when the batch size is Moiré's to set, else
 * runs of a size the workflow decides. */
export function countModeOf(gen: Generator | undefined, perRequest: number | null, builtinDefault: number): CountMode {
  // No workflow yet (loading): the built-in's, which counts images.
  if (!gen) return { kind: "images", perRequest: perRequest ?? builtinDefault };
  if (!gen.slots.batch_size) return { kind: "runs" };
  const own = gen.kind === "builtin" ? builtinDefault : (gen.slots.per_request ?? 1);
  return { kind: "images", perRequest: perRequest ?? own };
}

/** The batch size a workflow uses when the batch doesn't set one. */
export function defaultBatchSize(gen: Generator | undefined, builtinDefault: number): number {
  return gen?.kind === "builtin" ? builtinDefault : (gen?.slots.per_request ?? 1);
}

export type TestState = "ready" | "untested" | "running" | "waiting" | "failed";

/** Where a workflow's test run is. "waiting": it ran and made images that
 * aren't in the library yet (the scan, or a wrong output folder). A run that
 * made none failed. */
export function testState(gen: Generator): TestState {
  if (gen.ready) return "ready";
  const t = gen.test;
  if (!t) return "untested";
  if (["failed", "lost", "cancelled"].includes(t.state)) return "failed";
  if (t.state === "done") return t.outputs > 0 ? "waiting" : "failed";
  return "running";
}

/** A test can be (re)started unless one is in ComfyUI right now. */
export const canRunTest = (s: TestState) => s !== "running" && s !== "ready";

/** The picker's line under a workflow: txt2img for the built-in, else the
 * setup page's origin line (workflowOrigin) unless it only repeats the name. */
export function workflowLine(gen: Generator): string | undefined {
  if (gen.kind === "builtin") return "txt2img";
  const origin = workflowOrigin(gen.source ?? undefined);
  return origin === `From ${gen.name}` ? undefined : origin;
}

/** The picker's rows: "Set up a workflow" pinned first by the picker itself,
 * then the chosen one, then the rest in list order. */
export function workflowOptions(gens: readonly Generator[], chosen: string): PickerOption[] {
  const sorted = [...gens].sort((a, b) => Number(b._id === chosen) - Number(a._id === chosen));
  return sorted.map((g) => ({ value: g._id, label: g.name, detail: workflowLine(g) }));
}

/** A queue body without what this workflow can't take: no checkpoint or
 * size where it sets its own, no LoRAs (character ones included) without an
 * insertion point, no batch size where it decides. */
export function forWorkflow(body: QueueBody, bar: RunBar): QueueBody {
  return {
    ...body,
    checkpoint: bar.checkpoint ? body.checkpoint : null,
    width: bar.size ? body.width : null,
    height: bar.size ? body.height : null,
    per_request: bar.batchSize ? body.per_request : null,
    loras: bar.loras ? body.loras : [],
    characters: bar.loras ? body.characters : body.characters.map((c) => ({ ...c, lora: null })),
  };
}

/** Why Queue can't run yet, said on the button itself; null when it can. */
export function blockedReason(s: {
  connected: boolean;
  ready: boolean;
  outputLibraryId: string | null | undefined;
  /** Characters picked, and whether every one's recipe has loaded. */
  picked: number;
  loaded: boolean;
}): string | null {
  return !s.connected
    ? "Waiting for ComfyUI"
    : !s.ready
      ? "Run the test first"
      : !s.outputLibraryId
        ? "Set the output folder"
        : s.picked && !s.loaded
          ? "Loading character"
          : null;
}
