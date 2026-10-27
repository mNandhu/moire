/**
 * The composer filled from elsewhere: a batch's inputs ("Edit and queue"),
 * an image to remix, or a character or outfit picked on another page.
 */
import { batchCast } from "./batches";
import { compose } from "./compose";
import type { BatchInputs, Generator, RemixDoc, Sampling } from "./generate";
import { DEFAULT_FORM, type GenerateForm, type PresetRef } from "./generateForm";
import { composerFrom, keepOff, presetRef } from "./generateDraft";
import { MAX_CHARACTERS } from "./generationLimits";
import { pickFromInput, type OutfitPick } from "./outfit";

function loraPresetOf(composer: Record<string, unknown> | null | undefined, name: string): PresetRef {
  const all = composer?.loraPresets;
  if (!all || typeof all !== "object") return null;
  return presetRef((all as Record<string, unknown>)[name]) ?? null;
}

/** A batch's inputs back in the composer ("Edit and queue"). A typed name
 * stays; an auto name is picked again. */
export function formFromBatch(i: BatchInputs, name: string | null, workflow = "builtin"): GenerateForm {
  const c = i.composer && (i.composer as { v?: unknown }).v === 2 ? composerFrom(i.composer) : null;
  const chars = batchCast(i);
  return {
    ...DEFAULT_FORM,
    ...(c ?? {
      prompt: compose(i.base ?? "", i.extra ?? []),
      negative: compose(i.negative_base ?? "", i.negative_extra ?? []),
    }),
    checkpoint: i.checkpoint,
    sampling: { ...i.sampling },
    loras: i.loras.map((l) => ({ ...l, preset: loraPresetOf(i.composer, l.name) })),
    characters: chars.map((c) => c.tag),
    outfits: Object.fromEntries(chars.flatMap((c) => {
      const p = pickFromInput(c.outfit);
      return p ? [[c.tag, p]] : [];
    })),
    identityOff: keepOff(i.composer?.identityOff, chars.map((c) => c.tag)),
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
 * checkpoint, size and sampling unless it has a slot. A checkpoint slot
 * takes the image's checkpoint only on the image's `own` workflow; another
 * workflow starts on its own default, which fits its model family.
 * `current` gives what the image doesn't say (checkpoint, size). Pure. */
export function formFromRemix(
  doc: RemixDoc,
  target: Generator,
  seed: SeedChoice,
  current: GenerateForm,
  own = false,
): GenerateForm {
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
  const exposed = builtin ? null : Object.keys(target.sampling ?? {});
  for (const [k, v] of Object.entries(doc.sampling) as [keyof Sampling, never][]) {
    if (!exposed || exposed.includes(k)) sampling[k] = v;
  }
  return {
    ...DEFAULT_FORM,
    workflow: target._id,
    prompt: doc.prompt,
    negative: doc.negative,
    characters: doc.characters.slice(0, MAX_CHARACTERS),
    checkpoint:
      builtin || (slots.checkpoint && own)
        ? (doc.checkpoint ?? current.checkpoint)
        : slots.checkpoint
          ? target.checkpoint_default || current.checkpoint
          : current.checkpoint,
    sampling,
    loras: builtin ? doc.loras.map((l) => ({ name: l.name, strength: l.strength, preset: null })) : [],
    width: sizeSlot && doc.width ? doc.width : current.width,
    height: sizeSlot && doc.height ? doc.height : current.height,
    seed: seed === "same" && doc.seed != null ? { mode: "fixed", value: doc.seed } : { mode: "random", value: null },
    count: 1,
    remix,
  };
}

/** The draft no longer a remix: the image's seed it kept goes with it. */
function endRemix(f: GenerateForm): GenerateForm {
  if (!f.remix) return f;
  const kept = f.seed.mode === "fixed" && f.remix.seed != null && f.seed.value === f.remix.seed;
  return { ...f, remix: null, seed: kept ? { mode: "random", value: null } : f.seed };
}

/** The draft with `tag` as its one character, to start in what Settings
 * says new characters wear (a character page's Generate). A remix it was
 * is over. Pure. */
export function withCharacter(f: GenerateForm, tag: string): GenerateForm {
  return { ...endRemix(f), characters: [tag], outfits: {}, identityOff: {}, fresh: [tag] };
}

/** The draft with `tag` as its one character, wearing `pick` (an outfit's
 * Use in Generate). A remix it was is over. Pure. */
export function wearingOutfit(f: GenerateForm, tag: string, pick: OutfitPick): GenerateForm {
  return { ...endRemix(f), characters: [tag], outfits: { [tag]: pick }, identityOff: {}, fresh: [] };
}
