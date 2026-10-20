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

/** Layers in order, comma-joined: a string is free text written as is
 * (trailing comma dropped), an array a chip block (tags escaped, a chip
 * already written in an earlier block written once). */
export function composeParts(items: readonly (string | readonly string[])[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item === "string") {
      const text = item.trim().replace(/,\s*$/, "").trim();
      if (text) parts.push(text);
      continue;
    }
    for (const raw of item) {
      const word = raw.trim();
      if (!word || seen.has(word)) continue;
      seen.add(word);
      parts.push(chipText(word));
    }
  }
  return parts.join(", ");
}

/** Base text, then each chip block in order (batches from before the layered composer). */
export function compose(base: string, ...blocks: readonly (readonly string[])[]): string {
  return composeParts([base ?? "", ...blocks]);
}

const WEIGHT = /^[([]+|[)\]]+$|:\s*[\d.]+\s*[)\]]*$/g;

/** The first comma-separated terms of a prompt, for a batch's auto name:
 * weights and brackets dropped, embeddings and LoRA tags skipped. */
export function promptTerms(text: string, limit = 2): string[] {
  const out: string[] = [];
  for (const raw of (text ?? "").replace(/\n/g, ",").split(",")) {
    let term = raw.trim();
    if (!term || isEmbedding(term) || term.startsWith("<")) continue;
    term = term.replace(WEIGHT, "").trim().replace(WEIGHT, "").trim().replace(/\\/g, "");
    if (term) out.push(term.replace(/_/g, " "));
    if (out.length === limit) break;
  }
  return out;
}

/** Chip / name display: underscores read as spaces, embeddings by name. */
export function displayWord(word: string): string {
  if (isEmbedding(word)) return word.slice(EMBEDDING_PREFIX.length);
  return word.replace(/_/g, " ");
}
