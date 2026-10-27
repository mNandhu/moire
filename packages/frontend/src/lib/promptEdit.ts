/**
 * Editing a free-text prompt. Autocomplete: the term the caret is in, and the
 * text after a suggestion replaces it. Terms end at promptOutline's separators;
 * leading brackets of a weight (`(smi`) stay the user's. The rest of
 * promptOutline's reading is left out on purpose: a term still being typed
 * isn't finished (`hu_tao_(gen` is a qualifier not closed yet, not a group).
 * And Ctrl+Up / Ctrl+Down: a term's weight raised or lowered. Pure.
 */
import { SEPARATORS, promptTerms, type PromptTerm } from "./promptOutline";
import { isEmbedding } from "./compose";
import { formatWeight } from "./tags";

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
  if (!query.trim() || query.includes(":") && !isEmbedding(query)) return null;
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

/** ComfyUI's step for Ctrl+Up / Ctrl+Down. */
export const WEIGHT_STEP = 0.05;

type Span = { start: number; end: number };

/** Whether the `(` at `s` is closed by the `)` at `e - 1`, escapes skipped. */
function wraps(text: string, s: number, e: number): boolean {
  if (text[s] !== "(" || text[e - 1] !== ")") return false;
  let depth = 0;
  for (let i = s; i < e; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i === e - 1;
  }
  return false;
}

const GROUP_TAIL = /\s*:\s*-?\d*\.?\d+\s*$/;
const WRAP_AFTER = /^\s*(?::\s*-?\d*\.?\d+\s*)?\)/;

/** What a free selection weighs: the text inside its wrapper (`inner`) and
 * the wrapper (`outer`), so an already weighted `(a, b:1.2)` is re-weighted,
 * not wrapped again. */
function selectionSpans(text: string, start: number, end: number): { inner: Span; outer: Span } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (wraps(text, s, e)) {
    const body = text.slice(s + 1, e - 1);
    const tail = GROUP_TAIL.exec(body);
    return { inner: { start: s + 1, end: e - 1 - (tail ? tail[0].length : 0) }, outer: { start: s, end: e } };
  }
  const after = WRAP_AFTER.exec(text.slice(e));
  if (text[s - 1] === "(" && after && wraps(text, s - 1, e + after[0].length)) {
    return { inner: { start: s, end: e }, outer: { start: s - 1, end: e + after[0].length } };
  }
  return { inner: { start: s, end: e }, outer: { start: s, end: e } };
}

/** The first term inside `span` of `terms`. */
const firstIn = (terms: PromptTerm[], span: Span) =>
  terms.find((t) => t.nameStart >= span.start && t.nameEnd <= span.end);

/**
 * Ctrl+Up / Ctrl+Down in Generate's prompt: the weight of the term at the
 * caret, or of the selection, moved by `delta` from what ComfyUI reads it as
 * now (`promptTerms`). The term is written `(name:1.05)`; once back at the
 * weight its surroundings give it, it is written bare again. The returned
 * range is the text inside the wrapper, so the next press finds it again.
 * Null when there is nothing to weigh (a separator, a LoRA). Pure.
 */
export function bumpWeight(
  text: string,
  start: number,
  end: number,
  delta: number,
): { text: string; start: number; end: number } | null {
  const terms = promptTerms(text);
  const term =
    start === end
      ? terms.find((t) => t.start <= start && start <= t.end)
      : terms.find((t) => (t.nameStart === start && t.nameEnd === end) || (t.start === start && t.end === end));
  let inner: Span;
  let outer: Span;
  if (term) {
    inner = { start: term.nameStart, end: term.nameEnd };
    outer = { start: term.start, end: term.end };
  } else if (start !== end) {
    ({ inner, outer } = selectionSpans(text, start, end));
  } else return null;
  const first = firstIn(terms, inner);
  if (!first || first.kind === "lora") return null;
  const target = Math.max(0, Number(((first.weight ?? 1) + delta).toFixed(2)));
  const body = text.slice(inner.start, inner.end);
  const head = text.slice(0, outer.start);
  const tail = text.slice(outer.end);
  // Bare when that already reads as the target (back to 1, or to the weight
  // of the group it sits in) and still splits the same: without its
  // brackets, `1girl (smile)` would run into one term.
  const bare = head + body + tail;
  const bareTerms = promptTerms(bare);
  const there = firstIn(bareTerms, { start: outer.start, end: outer.start + body.length });
  if (there && bareTerms.length === terms.length && Number((there.weight ?? 1).toFixed(2)) === target) {
    return { text: bare, start: outer.start, end: outer.start + body.length };
  }
  return {
    text: `${head}(${body}:${formatWeight(target)})${tail}`,
    start: outer.start + 1,
    end: outer.start + 1 + body.length,
  };
}

/** The one span of `before` that differs from `after`: [start, end) in
 * `before` and the text that replaces it, so an edit can go in as typing
 * (`insertText`) and stay one undo step. */
export function changedSpan(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let back = 0;
  while (
    back < before.length - start &&
    back < after.length - start &&
    before[before.length - 1 - back] === after[after.length - 1 - back]
  ) {
    back++;
  }
  return { start, end: before.length - back, text: after.slice(start, after.length - back) };
}
