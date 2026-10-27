/**
 * The Generate composer's state and its request body.
 *
 * The positive prompt is an ordered list of layers: Prefix (a preset),
 * Character, Prompt (the main text), Style (the style LoRAs) and any the user
 * adds with "+" (free text, another preset, an embedding). The negative is a preset plus text.
 * A preset is referenced with a snapshot of its text, so a deleted preset
 * still sends what it said.
 */
import { composeParts, promptTerms } from "./compose";
import type {
  CharacterInput,
  EstimateBody,
  LoraPreset,
  Preset,
  PromptPart,
  QueueBody,
  Sampling,
  StyleLora,
} from "./generate";
import type { Outfits } from "./outfit";

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
  /** What each picked character wears; absent wears nothing. */
  outfits: Outfits;
  /** Per character: identity tags struck for this batch only (the recipe
   * keeps them). */
  identityOff: Record<string, string[]>;
  /** Characters just picked, still to start in what Settings says new
   * characters wear (an outfit chosen for one meanwhile wins). */
  fresh: string[];
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
  outfits: {},
  identityOff: {},
  fresh: [],
  width: 832,
  height: 1216,
  seed: { mode: "random", value: null },
  count: 4,
  perRequest: null,
  name: null,
  remix: null,
};

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
 * character's tags are their own block (what they wear another, right after). */
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

export const COMPOSER_KEYS = ["prefix", "blocks", "prompt", "negativePreset", "negative"] as const;

function composerState(f: GenerateForm): Record<string, unknown> {
  return {
    v: 2,
    ...Object.fromEntries(COMPOSER_KEYS.map((k) => [k, f[k]])),
    // The LoRAs themselves are in the batch's inputs; their presets are not.
    loraPresets: Object.fromEntries(f.loras.filter((l) => l.preset).map((l) => [l.name, l.preset])),
    // Batch-only strikes, so Edit and queue strikes the same tags again.
    identityOff: f.identityOff,
  };
}
