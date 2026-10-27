/**
 * Edits to the Generate composer's form, each a pure `(f, ...) => f` for
 * `setForm`. Kept apart from generateForm, which generateDraft imports, as
 * these need keepOff from there.
 */
import type { Generator, Recipe } from "./generate";
import type { GenerateForm } from "./generateForm";
import { keepOff } from "./generateDraft";
import { keepPicked, restoreWorn, strikeWorn, type OutfitPick } from "./outfit";
import { restoreOff, strikeOff, toggleOff } from "./recipe";

/** `tag` wearing `pick` (null wears nothing). An outfit chosen by hand
 * settles the character: no late Default over it. */
export function setOutfitPick(f: GenerateForm, tag: string, pick: OutfitPick | null): GenerateForm {
  const outfits = { ...f.outfits };
  if (pick) outfits[tag] = pick;
  else delete outfits[tag];
  return { ...f, outfits, fresh: f.fresh.filter((t) => t !== tag) };
}

/** The picked characters set to `tags`: what the others wore and had struck
 * goes, and a newly picked one is fresh. */
export function setCharacters(f: GenerateForm, tags: string[]): GenerateForm {
  return {
    ...f,
    characters: tags,
    outfits: keepPicked(f.outfits, tags),
    identityOff: keepOff(f.identityOff, tags),
    fresh: [...f.fresh, ...tags.filter((t) => !f.characters.includes(t))].filter((t) => tags.includes(t)),
  };
}

/** A fresh character `tag` settled, starting in `pick` unless an outfit was
 * chosen for it meanwhile. Unchanged when `tag` isn't fresh. */
export function settleFresh(f: GenerateForm, tag: string, pick: OutfitPick | null): GenerateForm {
  return f.fresh.includes(tag)
    ? {
        ...f,
        fresh: f.fresh.filter((t) => t !== tag),
        outfits: pick && f.characters.includes(tag) && !f.outfits[tag] ? { ...f.outfits, [tag]: pick } : f.outfits,
      }
    : f;
}

/** Switching workflows: settings tied to the old graph go; an empty
 * Prompt and Negative take the new one's own. */
export function switchWorkflow(f: GenerateForm, id: string, next: Generator | undefined): GenerateForm {
  return {
    ...f,
    workflow: id,
    sampling: {},
    perRequest: null,
    prompt: !f.prompt.trim() && next?.defaults ? next.defaults.base : f.prompt,
    negative: !f.negative.trim() && next?.defaults ? next.defaults.negative : f.negative,
  };
}

/** `character`'s identity `tag` struck for this batch, or brought back. */
export function toggleIdentityOff(f: GenerateForm, character: string, tag: string): GenerateForm {
  return { ...f, identityOff: { ...f.identityOff, [character]: toggleOff(f.identityOff[character], tag) } };
}

type StrikeRecipe = Pick<Recipe, "tag" | "identity">;

/** `tags` struck from character `r` for this batch: those of its identity,
 * and those its outfit wears. */
export function strikeCharacter(f: GenerateForm, r: StrikeRecipe, tags: string[]): GenerateForm {
  const mine = tags.filter((t) => r.identity.some((c) => c.tag === t));
  const out = { ...f, identityOff: { ...f.identityOff, [r.tag]: strikeOff(f.identityOff[r.tag], mine) } };
  const cur = f.outfits[r.tag];
  if (cur) out.outfits = { ...f.outfits, [r.tag]: strikeWorn(cur, tags.filter((t) => cur.tags.includes(t))) };
  return out;
}

/** strikeCharacter undone; the outfit only when it is still `wasPick`, the
 * one worn when the tags were struck. */
export function undoStrike(f: GenerateForm, r: StrikeRecipe, tags: string[], wasPick: OutfitPick | undefined): GenerateForm {
  const mine = tags.filter((t) => r.identity.some((c) => c.tag === t));
  const out = { ...f, identityOff: { ...f.identityOff, [r.tag]: restoreOff(f.identityOff[r.tag], mine) } };
  const cur = f.outfits[r.tag];
  if (cur && wasPick && cur.id === wasPick.id) out.outfits = { ...f.outfits, [r.tag]: restoreWorn(cur, wasPick, tags) };
  return out;
}
