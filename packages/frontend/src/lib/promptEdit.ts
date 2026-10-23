/**
 * Autocomplete in a free-text prompt: the term the caret is in, and the text
 * after a suggestion replaces it. Terms end at promptOutline's separators;
 * leading brackets of a weight (`(smi`) stay the user's. The rest of
 * promptOutline's reading is left out on purpose: a term still being typed
 * isn't finished (`hu_tao_(gen` is a qualifier not closed yet, not a group).
 * Pure.
 */
import { SEPARATORS } from "./promptOutline";

export type Term = { start: number; end: number; query: string };

/** The term around `caret`, or null when there's nothing typed there. */
export function termAt(text: string, caret: number): Term | null {
  let start = caret;
  while (start > 0 && !SEPARATORS.has(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && !SEPARATORS.has(text[end])) end++;
  // Leading spaces and weight brackets aren't part of the word.
  while (start < caret && /[\s([]/.test(text[start])) start++;
  const query = text.slice(start, caret);
  if (!query.trim() || query.includes(":") && !query.startsWith("embedding:")) return null;
  return { start, end, query };
}

/** `text` with the term replaced by `word`; a comma follows when the term was
 * the last one, so typing goes straight on to the next. */
export function replaceTerm(text: string, t: Term, word: string): { text: string; caret: number } {
  const after = text.slice(t.end);
  const tail = after.trim() ? after : ", ";
  const next = text.slice(0, t.start) + word + tail;
  const caret = t.start + word.length + (after.trim() ? 0 : 2);
  return { text: next, caret };
}
