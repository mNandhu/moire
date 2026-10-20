/**
 * The Character block from a recipe: what it writes into the prompt and which
 * LoRA it sends. Recipe edits (drops, LoRA, strength) are stored server-side;
 * the batch records the block as sent.
 */
import type { CharacterInput, Recipe } from "./generate";

/** The character tag, then the identity tags the user kept. */
export function characterTags(r: Recipe): string[] {
  return [r.tag, ...r.identity.filter((c) => !c.dropped).map((c) => c.tag)];
}

/** The Character block for the queue body. A LoRA that isn't installed is
 * left out (the block shows it as not installed). */
export function characterInput(r: Recipe, label: string): CharacterInput {
  return {
    tag: r.tag,
    label,
    tags: characterTags(r),
    lora: r.lora?.file ? { name: r.lora.file, strength: r.lora.strength } : null,
  };
}

/** The dropped list after toggling one identity tag. */
export function toggleDropped(r: Recipe, tag: string): string[] {
  const dropped = new Set(r.identity.filter((c) => c.dropped).map((c) => c.tag));
  if (dropped.has(tag)) dropped.delete(tag);
  else dropped.add(tag);
  return [...dropped].sort();
}
