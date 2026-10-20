/**
 * The Generate composer's state, its request body, and the per-viewer draft
 * kept in localStorage so a half-written prompt survives navigation.
 */
import type { BatchInputs, CharacterInput, LoraPick, NodeError, QueueBody } from "./generate";

export type GenerateForm = {
  base: string;
  extra: string[];
  negativeBase: string;
  negativeExtra: string[];
  checkpoint: string | null;
  loras: LoraPick[];
  /** The picked character's page key; its block comes from the recipe. */
  character: string | null;
  width: number;
  height: number;
  seed: { mode: "random" | "fixed"; value: number | null };
  count: number;
  /** A typed batch name; null keeps the auto name. */
  name: string | null;
};

export const DEFAULT_FORM: GenerateForm = {
  base: "",
  extra: [],
  negativeBase: "",
  negativeExtra: [],
  checkpoint: null,
  loras: [],
  character: null,
  width: 832,
  height: 1216,
  seed: { mode: "random", value: null },
  count: 4,
  name: null,
};

export function toQueueBody(f: GenerateForm, generatorId: string, character: CharacterInput | null = null): QueueBody {
  return {
    generator_id: generatorId,
    base: f.base,
    extra: f.extra,
    negative_base: f.negativeBase,
    negative_extra: f.negativeExtra,
    checkpoint: f.checkpoint,
    loras: f.loras,
    character,
    width: f.width,
    height: f.height,
    seed: f.seed.mode === "fixed" && f.seed.value != null ? f.seed : { mode: "random", value: null },
    count: f.count,
    name: f.name,
  };
}

/** A batch's inputs back in the composer ("Edit and queue"). A typed name
 * stays; an auto name is picked again. */
export function formFromBatch(i: BatchInputs, name: string | null): GenerateForm {
  return {
    base: i.base,
    extra: [...i.extra],
    negativeBase: i.negative_base,
    negativeExtra: [...i.negative_extra],
    checkpoint: i.checkpoint,
    loras: i.loras.map((l) => ({ ...l })),
    character: i.character?.tag ?? null,
    width: i.width ?? DEFAULT_FORM.width,
    height: i.height ?? DEFAULT_FORM.height,
    seed: i.seed.mode === "fixed" ? { ...i.seed } : { mode: "random", value: null },
    count: i.count,
    name,
  };
}

const DRAFT_KEY = "moire.generate.draft";

/** The saved draft merged over defaults; defaults when storage is empty,
 * blocked or holds something else. */
export function loadDraft(storage: Pick<Storage, "getItem"> | null = safeStorage()): GenerateForm {
  try {
    const raw = storage?.getItem(DRAFT_KEY);
    if (!raw) return DEFAULT_FORM;
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") return DEFAULT_FORM;
    const out = { ...DEFAULT_FORM };
    for (const k of Object.keys(DEFAULT_FORM) as (keyof GenerateForm)[]) {
      if (!(k in d)) continue;
      // Nullable fields take a string or null; the rest must keep their type.
      const ok = DEFAULT_FORM[k] === null ? d[k] === null || typeof d[k] === "string" : typeof d[k] === typeof DEFAULT_FORM[k];
      if (ok) {
        (out as Record<string, unknown>)[k] = d[k];
      }
    }
    return out;
  } catch {
    return DEFAULT_FORM;
  }
}

export function saveDraft(f: GenerateForm, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(DRAFT_KEY, JSON.stringify(f));
  } catch {
    /* private window or quota: the draft just isn't kept */
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** What a rejection flags: the checkpoint, and which LoRA names. */
export function rejectedFields(errors: readonly NodeError[]): { checkpoint: boolean; loras: Set<string> } {
  return {
    checkpoint: errors.some((e) => e.field === "checkpoint"),
    loras: new Set(errors.filter((e) => e.field === "lora" && e.lora_name).map((e) => e.lora_name!)),
  };
}
