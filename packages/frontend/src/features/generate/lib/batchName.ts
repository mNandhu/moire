/**
 * The batch auto-name, as the backend picks it (`generation_compose.auto_name`):
 * "Character, Outfit"; without a character, "Generator, first two Extra tags";
 * else "Batch <n>". Built from the picks, never parsed from prompt text.
 */
import { displayWord, isEmbedding } from "./compose";

export function autoBatchName({
  number,
  generator,
  extra = [],
  character,
  outfit,
}: {
  number: number | null;
  generator: string;
  extra?: readonly string[];
  character?: string | null;
  outfit?: string | null;
}): string {
  if (character) return [displayWord(character), outfit].filter(Boolean).join(", ");
  const words = extra
    .filter((w) => w.trim() && !isEmbedding(w))
    .slice(0, 2)
    .map(displayWord);
  if (words.length) return [generator, ...words].join(", ");
  return number == null ? "Batch" : `Batch ${number}`;
}
