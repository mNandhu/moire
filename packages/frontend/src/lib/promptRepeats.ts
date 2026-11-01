/**
 * Tags written in the Prompt that a layer already sends: the Prefix, or a
 * character with what they wear. A tag counts however it is written: bare,
 * weighted, or inside a weighted group (`(masterpiece, best quality:1.1)`,
 * as a remixed prompt often has it). Left alone: LoRAs and embeddings, a
 * side of a prompt edit (`[a:b:0.5]`, which goes whole), and anything
 * grouped in a chunk split by `AND` (`(1girl, eula) AND (1girl, furina)`),
 * where a repeat is on purpose. Terms are read by promptOutline, the
 * board's own splitter.
 */
import { promptTerms, removeTerms, type PromptTerm } from "./promptOutline";
import { canonicalName } from "./tags";

type Term = {
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
  key: string | null;
  kind: PromptTerm["kind"];
  /** As ComfyUI reads it, group and nesting included. */
  weight: number;
  grouped: boolean;
};

const BREAKS = /\bBREAK\b/g;
const REGIONS = /\bAND\b/;

/** The prompt's terms that count, with where each sits; `key` is its tag
 * name, null for a LoRA, an embedding or a side of a prompt edit. A grouped
 * term in a chunk (between `BREAK`s) split by `AND` is left out. Pure. */
export function topTerms(text: string): Term[] {
  // Where each chunk ends, and whether `AND` splits it into regions.
  const ends = [...[...text.matchAll(BREAKS)].map((m) => m.index), text.length];
  const regions = ends.map((end, i) => REGIONS.test(text.slice(i ? ends[i - 1] : 0, end)));
  const regional = (at: number) => regions[ends.findIndex((end) => at < end)] ?? false;
  return promptTerms(text)
    .filter((t) => !t.grouped || !regional(t.start))
    .map((t) => {
      const tag = t.kind !== "lora" && t.kind !== "embedding" && !t.inEdit;
      const { start, end, nameStart, nameEnd, kind, grouped } = t;
      return { start, end, nameStart, nameEnd, key: tag ? t.name : null, kind, weight: t.weight ?? 1, grouped };
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
