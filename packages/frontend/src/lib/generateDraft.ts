/**
 * Reading the Generate draft (kept in localStorage so a half-written prompt
 * survives navigation) and the composer state a batch stored. Both are stored
 * data: every field is checked, falling back field by field.
 */
import { compose } from "./compose";
import type { StyleLora } from "./generate";
import { DEFAULT_BLOCKS, DEFAULT_FORM, type Block, type COMPOSER_KEYS, type GenerateForm, type PresetRef } from "./generateForm";
import { MAX_CHARACTERS, PER_REQUEST_MAX } from "./generationLimits";
import { keepPicked, validOutfits } from "./outfit";
import { samplingOf } from "./sampling";

// -- Validation (drafts and batches are stored data: never trust their shape) --

const isStr = (v: unknown): v is string => typeof v === "string";

export function presetRef(v: unknown): PresetRef | undefined {
  if (v === null) return null;
  if (v && typeof v === "object" && isStr((v as { id: unknown }).id) && isStr((v as { text: unknown }).text)) {
    const r = v as { id: string; text: string };
    return { id: r.id, text: r.text };
  }
  return undefined;
}

function block(v: unknown): Block | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if (b.kind === "prefix" || b.kind === "character" || b.kind === "prompt" || b.kind === "style") return { kind: b.kind };
  if (!isStr(b.id)) return null;
  if (b.kind === "text" && isStr(b.text)) return { kind: "text", id: b.id, text: b.text };
  if (b.kind === "embedding" && isStr(b.name)) return { kind: "embedding", id: b.id, name: b.name };
  if (b.kind === "preset") {
    const p = presetRef(b.preset);
    return p === undefined ? null : { kind: "preset", id: b.id, preset: p };
  }
  return null;
}

/** Stored layers, or the defaults when they're malformed: every layer valid
 * and Prefix, Character, Prompt and Style each there once. Layers saved
 * before Style existed get it after the Prompt. */
export function validBlocks(v: unknown): Block[] {
  if (!Array.isArray(v)) return DEFAULT_BLOCKS;
  const out = v.map(block);
  if (out.some((b) => b === null)) return DEFAULT_BLOCKS;
  let blocks = out as Block[];
  if (!blocks.some((b) => b.kind === "style")) {
    const at = blocks.findIndex((b) => b.kind === "prompt") + 1;
    blocks = [...blocks.slice(0, at), { kind: "style" }, ...blocks.slice(at)];
  }
  for (const k of ["prefix", "character", "prompt", "style"] as const) {
    if (blocks.filter((b) => b.kind === k).length !== 1) return DEFAULT_BLOCKS;
  }
  return blocks;
}

/** The composer fields from a stored record, falling back field by field. */
export function composerFrom(d: Record<string, unknown>): Pick<GenerateForm, (typeof COMPOSER_KEYS)[number]> {
  const prefix = presetRef(d.prefix);
  const negativePreset = presetRef(d.negativePreset);
  return {
    prefix: prefix === undefined ? null : prefix,
    blocks: validBlocks(d.blocks),
    prompt: isStr(d.prompt) ? d.prompt : "",
    negativePreset: negativePreset === undefined ? null : negativePreset,
    negative: isStr(d.negative) ? d.negative : "",
  };
}

/** The old Base + Extra composer's text: it held the user's whole prompt, so
 * it becomes the Prompt (not the Prefix). */
function migrated(d: Record<string, unknown>): Partial<GenerateForm> {
  const tags = (v: unknown) => (Array.isArray(v) ? v.filter(isStr) : []);
  return {
    prompt: compose(isStr(d.base) ? d.base : "", tags(d.extra)),
    negative: compose(isStr(d.negativeBase) ? d.negativeBase : "", tags(d.negativeExtra)),
  };
}

/** Struck identity tags of characters still in the prompt; malformed or
 * empty entries dropped (a draft is stored data). Pure. */
export function keepOff(v: unknown, characters: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const c of characters) {
    const tags = (v as Record<string, unknown>)[c];
    const list = Array.isArray(tags) ? [...new Set(tags.filter(isStr))] : [];
    if (list.length) out[c] = list;
  }
  return out;
}

const DRAFT_KEY = "moire.generate.draft";

/** The saved draft merged over defaults; defaults when storage is empty,
 * blocked or holds something else. A draft from the old composer has its
 * Base + Extra moved into the Prompt. */
export function loadDraft(storage: Pick<Storage, "getItem"> | null = safeStorage()): GenerateForm {
  try {
    const raw = storage?.getItem(DRAFT_KEY);
    if (!raw) return DEFAULT_FORM;
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object" || Array.isArray(d)) return DEFAULT_FORM;
    const out: GenerateForm = { ...DEFAULT_FORM, ...composerFrom(d) };
    if (!("prompt" in d) && ("base" in d || "extra" in d)) Object.assign(out, migrated(d));
    if (isStr(d.checkpoint) || d.checkpoint === null) out.checkpoint = d.checkpoint;
    out.sampling = samplingOf(d.sampling);
    // Drafts from before several characters keep their one.
    if (Array.isArray(d.characters)) out.characters = [...new Set<string>(d.characters.filter(isStr))].slice(0, MAX_CHARACTERS);
    else if (isStr(d.character)) out.characters = [d.character];
    out.outfits = keepPicked(validOutfits(d.outfits), out.characters);
    out.identityOff = keepOff(d.identityOff, out.characters);
    if (Array.isArray(d.fresh)) out.fresh = d.fresh.filter((t: unknown) => isStr(t) && out.characters.includes(t));
    if (isStr(d.name) || d.name === null) out.name = d.name;
    if (isStr(d.workflow) && d.workflow) out.workflow = d.workflow;
    for (const k of ["width", "height", "count"] as const) if (typeof d[k] === "number") out[k] = d[k];
    if (Number.isInteger(d.perRequest) && d.perRequest >= 1 && d.perRequest <= PER_REQUEST_MAX) out.perRequest = d.perRequest;
    if (Array.isArray(d.loras)) {
      out.loras = d.loras
        .filter(
          (l: unknown): l is StyleLora =>
            !!l && typeof l === "object" && isStr((l as StyleLora).name) && typeof (l as StyleLora).strength === "number",
        )
        .map((l: StyleLora) => ({ name: l.name, strength: l.strength, preset: presetRef(l.preset) ?? null }));
    }
    const rx = d.remix;
    if (rx && typeof rx === "object" && isStr(rx.image) && (rx.seed === null || Number.isInteger(rx.seed))) {
      out.remix = { image: rx.image, seed: rx.seed };
    }
    const seed = d.seed;
    if (seed && (seed.mode === "random" || seed.mode === "fixed") && (seed.value === null || typeof seed.value === "number")) {
      out.seed = { mode: seed.mode, value: seed.value };
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
