/**
 * Tags written in both the Prefix and the Prompt. Only plain top-level terms
 * count: anything weighted, bracketed or inside a group (`(1girl, eula) AND
 * (1girl, furina)`) is left alone, since a repeat there is on purpose.
 */
import { canonicalName } from "./tags";

type Term = { start: number; end: number; key: string | null };

const OPEN = "([{<";
const CLOSE = ")]}>";

/** The prompt's top-level terms, split on commas and newlines, with where
 * each sits; `key` is its tag name, null for anything not a plain tag. */
function topTerms(text: string): Term[] {
  const out: Term[] = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const word = raw.trim();
    if (word) {
      const plain = !/[()[\]{}<>:\\]/.test(word) && !/^(AND|BREAK)$/.test(word);
      out.push({ start: start + lead, end: start + lead + word.length, key: plain ? canonicalName(word).toLowerCase() : null });
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "," || c === "\n")) {
      push(i);
      start = i + 1;
    }
  }
  push(text.length);
  return out;
}

/** The prompt's plain tags the prefix also has, as written in the prompt,
 * each once. Pure. */
export function prefixRepeats(prefix: string, prompt: string): string[] {
  const inPrefix = new Set(topTerms(prefix).flatMap((t) => (t.key ? [t.key] : [])));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of topTerms(prompt)) {
    if (!t.key || !inPrefix.has(t.key) || seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(prompt.slice(t.start, t.end));
  }
  return out;
}

/** `prompt` without its plain top-level terms named in `words`; the rest as
 * written, kept terms joined by the separators that stood between them (a
 * line break wins over a comma). Pure. */
export function withoutTerms(prompt: string, words: readonly string[]): string {
  const drop = new Set(words.map((w) => canonicalName(w.trim()).toLowerCase()));
  const terms = topTerms(prompt);
  if (!terms.length) return prompt;
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
  return out + prompt.slice(terms[terms.length - 1].end);
}
