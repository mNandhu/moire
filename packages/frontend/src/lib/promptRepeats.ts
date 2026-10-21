/**
 * Tags written in the Prompt that a layer already sends: the Prefix, or a
 * character with what they wear. Only plain top-level terms
 * count: anything weighted, bracketed or inside a group (`(1girl, eula) AND
 * (1girl, furina)`) is left alone, since a repeat there is on purpose.
 */
import { canonicalName } from "./tags";

type Term = { start: number; end: number; key: string | null };

const OPEN = "([{";
const CLOSE = ")]}";

/** A term's tag name, or null when it isn't a plain tag (weighted,
 * bracketed, a LoRA, AND / BREAK). Escaped parentheses are part of a tag
 * (`hu_tao_\(genshin_impact\)`). */
function keyOf(word: string): string | null {
  const bare = word.replace(/\\([()])/g, "$1");
  if (/^(AND|BREAK)$/.test(word) || /[[\]{}<>:\\]/.test(bare) || /[()]/.test(word.replace(/\\[()]/g, ""))) return null;
  return canonicalName(bare).toLowerCase();
}

/** The prompt's top-level terms, split on commas and newlines, with where
 * each sits; `key` is its tag name, null for anything not a plain tag. */
function topTerms(text: string): Term[] {
  const out: Term[] = [];
  let depth = 0;
  // `<lora:x:1>` nests; a lone `<` or `>` (`>_<`) doesn't.
  let angle = false;
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const word = raw.trim();
    if (word) {
      out.push({ start: start + lead, end: start + lead + word.length, key: keyOf(word) });
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === "<" && !angle && /[a-z]/i.test(text[i + 1] ?? "")) angle = true;
    else if (c === ">" && angle) angle = false;
    else if (depth === 0 && !angle && (c === "," || c === "\n")) {
      push(i);
      start = i + 1;
    }
  }
  push(text.length);
  return out;
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
 * it took out; the rest as written, kept terms joined by the separators that
 * stood between them (a line break wins over a comma). Pure. */
export function withoutTerms(prompt: string, words: readonly string[]): { text: string; removed: number } {
  const drop = new Set(words.flatMap((w) => keyOf(w.trim()) ?? []));
  const terms = topTerms(prompt);
  if (!terms.length) return { text: prompt, removed: 0 };
  const gone = (t: Term) => !!t.key && drop.has(t.key);
  let out = prompt.slice(0, terms[0].start);
  let last = -1;
  terms.forEach((t, i) => {
    if (gone(t)) return;
    if (last >= 0) {
      const seps = terms.slice(last, i).map((a, j) => prompt.slice(a.end, terms[last + j + 1].start));
      out += seps.find((s) => s.includes("\n")) ?? seps[0];
    }
    out += prompt.slice(t.start, t.end);
    last = i;
  });
  return { text: out + prompt.slice(terms[terms.length - 1].end), removed: terms.filter(gone).length };
}
