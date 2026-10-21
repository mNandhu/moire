/**
 * The Generate composer's state, its request body, and the per-viewer draft
 * kept in localStorage so a half-written prompt survives navigation.
 *
 * The positive prompt is an ordered list of layers: Prefix (a preset),
 * Character, Prompt (the main text), Style (the style LoRAs) and any the user
 * adds with "+" (free text, another preset, an embedding). The negative is a preset plus text.
 * A preset is referenced with a snapshot of its text, so a deleted preset
 * still sends what it said.
 */
import { compose, composeParts, promptTerms } from "./compose";
import type {
  BatchInputs,
  CharacterInput,
  EstimateBody,
  Generator,
  LoraPreset,
  NodeError,
  Preset,
  PromptPart,
  QueueBody,
  RemixDoc,
  Sampling,
  StyleLora,
} from "./generate";

export type PresetRef = { id: string; text: string } | null;

export type Block =
  | { kind: "prefix" }
  | { kind: "character" }
  | { kind: "prompt" }
  | { kind: "style" }
  | { kind: "text"; id: string; text: string }
  | { kind: "preset"; id: string; preset: PresetRef }
  | { kind: "embedding"; id: string; name: string };

export type AddedKind = "text" | "preset" | "embedding";

export type GenerateForm = {
  /** The workflow (Generator id) this page runs. */
  workflow: string;
  prefix: PresetRef;
  blocks: Block[];
  /** The main text: scene, pose, everything that isn't boilerplate. */
  prompt: string;
  negativePreset: PresetRef;
  negative: string;
  checkpoint: string | null;
  /** Only what the user changed; the rest is the Generator's. */
  sampling: Sampling;
  /** Style LoRAs, each with its activation preset. */
  loras: StyleLora[];
  /** The picked characters' page keys, in prompt order; each one's block
   * comes from its recipe. */
  characters: string[];
  width: number;
  height: number;
  seed: { mode: "random" | "fixed"; value: number | null };
  count: number;
  /** Images per request; null keeps the Generator's. */
  perRequest: number | null;
  /** A typed batch name; null keeps the auto name. */
  name: string | null;
  /** The image this draft remixes (shown above the layers until cleared);
   * `seed` is the image's when the remix kept it. */
  remix: { image: string; seed: number | null } | null;
};

export const DEFAULT_BLOCKS: Block[] = [{ kind: "prefix" }, { kind: "character" }, { kind: "prompt" }, { kind: "style" }];

export const DEFAULT_FORM: GenerateForm = {
  workflow: "builtin",
  prefix: null,
  blocks: DEFAULT_BLOCKS,
  prompt: "",
  negativePreset: null,
  negative: "",
  checkpoint: null,
  sampling: {},
  loras: [],
  characters: [],
  width: 832,
  height: 1216,
  seed: { mode: "random", value: null },
  count: 4,
  perRequest: null,
  name: null,
  remix: null,
};

/** As many characters as one prompt takes (the backend keeps this many). */
export const MAX_CHARACTERS = 8;

/** The characters with row `i` changed to `tag` (null removes it); a tag
 * already picked elsewhere moves here instead of showing twice. Pure. */
export function replaceCharacter(tags: readonly string[], i: number, tag: string | null): string[] {
  if (tag === null) return tags.filter((_, j) => j !== i);
  return tags.map((x, j) => (j === i ? tag : x)).filter((x, j) => x !== tag || j === i);
}

let nextId = 0;
const newId = () => `b${Date.now().toString(36)}${(nextId++).toString(36)}`;

/** A new layer of `kind` inserted before position `at`. */
export function insertBlock(blocks: readonly Block[], at: number, kind: AddedKind): Block[] {
  const b: Block =
    kind === "text"
      ? { kind, id: newId(), text: "" }
      : kind === "preset"
        ? { kind, id: newId(), preset: null }
        : { kind, id: newId(), name: "" };
  return [...blocks.slice(0, at), b, ...blocks.slice(at)];
}

export function updateBlock(blocks: readonly Block[], id: string, patch: Partial<Block>): Block[] {
  return blocks.map((b) => ("id" in b && b.id === id ? ({ ...b, ...patch } as Block) : b));
}

export function removeBlock(blocks: readonly Block[], id: string): Block[] {
  return blocks.filter((b) => !("id" in b && b.id === id));
}

/** A preset's current text, else the snapshot taken when it was picked. */
export function presetText(ref: PresetRef, presets: readonly { _id: string; text: string }[] | undefined): string {
  if (!ref) return "";
  return presets?.find((p) => p._id === ref.id)?.text ?? ref.text;
}

/** A style LoRA's activation words: its preset's current text, else the
 * snapshot taken when it was picked. */
export function loraWords(l: StyleLora, loraPresets: readonly LoraPreset[] | undefined): string {
  return presetText(l.preset ?? null, loraPresets);
}

/** The ordered parts the backend composes (and the batch records). */
export function toParts(
  f: GenerateForm,
  presets: readonly Preset[] | undefined,
  loraPresets?: readonly LoraPreset[],
): { positive: PromptPart[]; negative: PromptPart[] } {
  const name = (ref: PresetRef) => presets?.find((p) => p._id === ref?.id)?.name ?? "";
  const positive: PromptPart[] = [];
  for (const b of f.blocks) {
    if (b.kind === "prefix") positive.push({ kind: "text", role: "prefix", label: name(f.prefix), text: presetText(f.prefix, presets) });
    else if (b.kind === "character") positive.push({ kind: "character" });
    else if (b.kind === "prompt") positive.push({ kind: "text", role: "prompt", text: f.prompt });
    else if (b.kind === "style") {
      const words = f.loras.map((l) => loraWords(l, loraPresets).trim()).filter(Boolean);
      if (words.length) positive.push({ kind: "text", role: "style", text: words.join(", ") });
    }
    else if (b.kind === "text") positive.push({ kind: "text", role: "text", text: b.text });
    else if (b.kind === "preset") positive.push({ kind: "text", role: "preset", label: name(b.preset), text: presetText(b.preset, presets) });
    else if (b.name) positive.push({ kind: "embedding", name: b.name });
  }
  return {
    positive,
    negative: [
      { kind: "text", role: "prefix", label: name(f.negativePreset), text: presetText(f.negativePreset, presets) },
      { kind: "text", role: "prompt", text: f.negative },
    ],
  };
}

/** What the backend will send, for the "Prompt as sent" preview: each
 * character's tags are their own block. */
export function previewText(parts: readonly PromptPart[], characterTags: readonly (readonly string[])[]): string {
  return composeParts(
    parts.flatMap((p) =>
      p.kind === "text"
        ? [p.text ?? ""]
        : p.kind === "character"
          ? characterTags
          : [p.name ? `embedding:${p.name}` : ""],
    ),
  );
}

/** Words for the auto batch name when no character is picked. */
export function nameWords(f: Pick<GenerateForm, "prompt">): string[] {
  return promptTerms(f.prompt);
}

export function toQueueBody(
  f: GenerateForm,
  generatorId: string,
  characters: CharacterInput[],
  presets: readonly Preset[] | undefined,
  loraPresets?: readonly LoraPreset[],
): QueueBody {
  const { positive, negative } = toParts(f, presets, loraPresets);
  return {
    generator_id: generatorId,
    checkpoint: f.checkpoint,
    sampling: f.sampling,
    loras: f.loras.map(({ name, strength }) => ({ name, strength })),
    characters,
    positive,
    negative,
    composer: composerState(f),
    width: f.width,
    height: f.height,
    seed: f.seed.mode === "fixed" && f.seed.value != null ? f.seed : { mode: "random", value: null },
    count: f.count,
    per_request: f.perRequest,
    name: f.name,
  };
}

/** The part of the queue body that decides how long a batch takes, for the
 * run-time estimate: prompts, LoRAs and seeds don't, so editing them doesn't
 * ask again. */
export function toEstimateBody(f: GenerateForm, generatorId: string): EstimateBody {
  return {
    generator_id: generatorId,
    checkpoint: f.checkpoint,
    sampling: f.sampling,
    width: f.width,
    height: f.height,
    count: f.count,
    per_request: f.perRequest,
  };
}

const COMPOSER_KEYS = ["prefix", "blocks", "prompt", "negativePreset", "negative"] as const;

function composerState(f: GenerateForm): Record<string, unknown> {
  return {
    v: 2,
    ...Object.fromEntries(COMPOSER_KEYS.map((k) => [k, f[k]])),
    // The LoRAs themselves are in the batch's inputs; their presets are not.
    loraPresets: Object.fromEntries(f.loras.filter((l) => l.preset).map((l) => [l.name, l.preset])),
  };
}

// -- Validation (drafts and batches are stored data: never trust their shape) --

const isStr = (v: unknown): v is string => typeof v === "string";

function presetRef(v: unknown): PresetRef | undefined {
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
function composerFrom(d: Record<string, unknown>): Pick<GenerateForm, (typeof COMPOSER_KEYS)[number]> {
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

function loraPresetOf(composer: Record<string, unknown> | null | undefined, name: string): PresetRef {
  const all = composer?.loraPresets;
  if (!all || typeof all !== "object") return null;
  return presetRef((all as Record<string, unknown>)[name]) ?? null;
}

/** A batch's inputs back in the composer ("Edit and queue"). A typed name
 * stays; an auto name is picked again. */
export function formFromBatch(i: BatchInputs, name: string | null, workflow = "builtin"): GenerateForm {
  const c = i.composer && (i.composer as { v?: unknown }).v === 2 ? composerFrom(i.composer) : null;
  return {
    ...DEFAULT_FORM,
    ...(c ?? {
      prompt: compose(i.base ?? "", i.extra ?? []),
      negative: compose(i.negative_base ?? "", i.negative_extra ?? []),
    }),
    checkpoint: i.checkpoint,
    sampling: { ...i.sampling },
    loras: i.loras.map((l) => ({ ...l, preset: loraPresetOf(i.composer, l.name) })),
    characters: (i.characters ?? (i.character ? [i.character] : [])).map((c) => c.tag),
    width: i.width ?? DEFAULT_FORM.width,
    height: i.height ?? DEFAULT_FORM.height,
    seed: i.seed.mode === "fixed" ? { ...i.seed } : { mode: "random", value: null },
    count: i.count,
    perRequest: i.per_request_asked ?? null,
    name,
    workflow,
  };
}

export type SeedChoice = "same" | "new";

/** The composer for remixing an image with `target`. An image Moiré queued
 * replays its batch when remixed with that batch's workflow (same seed: the
 * whole request again, so the image is among its results). Otherwise the
 * image's own values, each only where the workflow takes it: the built-in
 * takes everything; a custom workflow keeps its graph's own LoRAs, and its
 * checkpoint, size and sampling unless it has a slot. `current` gives what
 * the image doesn't say (checkpoint, size). Pure. */
export function formFromRemix(doc: RemixDoc, target: Generator, seed: SeedChoice, current: GenerateForm): GenerateForm {
  const remix = { image: doc.image_id, seed: seed === "same" ? doc.seed : null };
  const b = doc.batch;
  if (b && !b.inputs.test && b.generator_id === target._id) {
    const f = formFromBatch(b.inputs, null, target._id);
    const same = seed === "same" && b.seed != null;
    return {
      ...f,
      seed: same ? { mode: "fixed", value: b.seed } : { mode: "random", value: null },
      count: same ? Math.max(1, b.images ?? 1) : 1,
      remix: { image: doc.image_id, seed: same ? b.seed : null },
    };
  }
  const builtin = target.kind === "builtin";
  const slots = target.slots;
  const sizeSlot = builtin || (!!slots.width && !!slots.height);
  const sampling: Sampling = {};
  const own = builtin ? null : Object.keys(target.sampling ?? {});
  for (const [k, v] of Object.entries(doc.sampling) as [keyof Sampling, never][]) {
    if (!own || own.includes(k)) sampling[k] = v;
  }
  return {
    ...DEFAULT_FORM,
    workflow: target._id,
    prompt: doc.prompt,
    negative: doc.negative,
    characters: doc.characters.slice(0, MAX_CHARACTERS),
    checkpoint: builtin || slots.checkpoint ? (doc.checkpoint ?? current.checkpoint) : current.checkpoint,
    sampling,
    loras: builtin ? doc.loras.map((l) => ({ name: l.name, strength: l.strength, preset: null })) : [],
    width: sizeSlot && doc.width ? doc.width : current.width,
    height: sizeSlot && doc.height ? doc.height : current.height,
    seed: seed === "same" && doc.seed != null ? { mode: "fixed", value: doc.seed } : { mode: "random", value: null },
    count: 1,
    remix,
  };
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
    if (isStr(d.name) || d.name === null) out.name = d.name;
    if (isStr(d.workflow) && d.workflow) out.workflow = d.workflow;
    for (const k of ["width", "height", "count"] as const) if (typeof d[k] === "number") out[k] = d[k];
    if (Number.isInteger(d.perRequest) && d.perRequest >= 1 && d.perRequest <= 64) out.perRequest = d.perRequest;
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

/** The sampling settings a stored value holds, the rest dropped. Pure. */
export function samplingOf(v: unknown): Sampling {
  if (!v || typeof v !== "object") return {};
  const d = v as Record<string, unknown>;
  const out: Sampling = {};
  if (isStr(d.sampler)) out.sampler = d.sampler;
  if (isStr(d.scheduler)) out.scheduler = d.scheduler;
  // The backend's limits; anything else is left to the Generator.
  if (Number.isInteger(d.steps) && (d.steps as number) >= 1 && (d.steps as number) <= 200) out.steps = d.steps as number;
  if (typeof d.cfg === "number" && d.cfg >= 0 && d.cfg <= 30) out.cfg = d.cfg;
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
