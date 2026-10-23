/**
 * Tags written in the Prompt that a layer already sends: the Prefix, or a
 * character with what they wear. Only plain top-level terms
 * count: anything weighted, bracketed or inside a group (`(1girl, eula) AND
 * (1girl, furina)`) is left alone, since a repeat there is on purpose.
 * Terms are read by promptOutline, the board's own splitter.
 */
import { promptTerms, removeTerms } from "./promptOutline";
import { canonicalName } from "./tags";

type Term = { start: number; end: number; key: string | null };

/** The prompt's terms outside groups, with where each sits; `key` is its
 * tag name, null for anything not a plain tag (weighted, bracketed, a LoRA
 * or embedding). */
function topTerms(text: string): Term[] {
  return promptTerms(text)
    .filter((t) => !t.grouped)
    .map((t) => {
      const plain = t.kind !== "lora" && t.kind !== "embedding" && t.start === t.nameStart && t.end === t.nameEnd;
      return { start: t.start, end: t.end, key: plain ? t.name : null };
    });
}

/** A word's tag name, or null when it isn't one plain tag. */
function keyOf(word: string): string | null {
  const terms = topTerms(word);
  return terms.length === 1 ? terms[0].key : null;
}

/** The prompt's plain tags whose names are in `keys`, as written in the
 * prompt, each once. */
function repeatsOf(keys: ReadonlySet<string>, prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of topTerms(prompt)) {
    if (!t.key || !keys.has(t.key) || seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(prompt.slice(t.start, t.end));
  }
  return out;
}

/** The prompt's plain tags the prefix also has, as written in the prompt,
 * each once. Pure. */
export function prefixRepeats(prefix: string, prompt: string): string[] {
  return repeatsOf(new Set(topTerms(prefix).flatMap((t) => (t.key ? [t.key] : []))), prompt);
}

/** The prompt's plain tags named in `tags` (stored names, e.g. a character's
 * and its outfit's), as written in the prompt, each once. Pure. */
export function tagRepeats(tags: readonly string[], prompt: string): string[] {
  // A tag typed into an outfit can keep the prompt's `\(` escapes.
  return repeatsOf(new Set(tags.map((t) => canonicalName(t.replace(/\\([()])/g, "$1")).toLowerCase())), prompt);
}

/** `prompt` without its plain top-level terms named in `words`, and how many
 * it took out; the rest as written, each term going with the separator
 * promptOutline's removeTerms gives it. Pure. */
export function withoutTerms(prompt: string, words: readonly string[]): { text: string; removed: number } {
  const drop = new Set(words.flatMap((w) => keyOf(w.trim()) ?? []));
  const gone = topTerms(prompt).filter((t) => !!t.key && drop.has(t.key));
  return { text: removeTerms(prompt, gone), removed: gone.length };
}
