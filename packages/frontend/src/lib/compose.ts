/**
 * Prompt blocks to ComfyUI prompt text: the preview of what the backend's
 * `services/generation_compose.py` sends. Keep the two in step (same cases in
 * `compose.test.ts` and `test_generation_compose.py`).
 *
 * Positive = Base + Character + Outfit + Extra; negative = Base + Extra. Base is
 * free text written as is; chip blocks hold canonical tag names (underscores)
 * or `embedding:name` words.
 */

export const EMBEDDING_PREFIX = "embedding:";

export function isEmbedding(word: string): boolean {
  return word.startsWith(EMBEDDING_PREFIX);
}

function chipText(word: string): string {
  // Embedding names are file names, sent untouched; tag parentheses are
  // escaped so ComfyUI doesn't read them as weights.
  return isEmbedding(word) ? word : word.replace(/([()])/g, "\\$1");
}

/** Base text, then each chip block in order, comma-joined; a chip already
 * written in an earlier block is written once. */
export function compose(base: string, ...blocks: readonly (readonly string[])[]): string {
  const parts: string[] = [];
  const text = (base ?? "").trim().replace(/,\s*$/, "").trim();
  if (text) parts.push(text);
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const raw of block) {
      const word = raw.trim();
      if (!word || seen.has(word)) continue;
      seen.add(word);
      parts.push(chipText(word));
    }
  }
  return parts.join(", ");
}

/** Chip / name display: underscores read as spaces, embeddings by name. */
export function displayWord(word: string): string {
  if (isEmbedding(word)) return word.slice(EMBEDDING_PREFIX.length);
  return word.replace(/_/g, " ");
}
