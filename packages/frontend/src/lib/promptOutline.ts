/**
 * Generate's Prompt read as terms for the prompt board: each comma piece with
 * where it sits in the text, its tag name and its weight, so the board can
 * place it (`/tags/place`), take it out, or swap an alias for its tag without
 * touching the rest of what was written. Pure.
 */

export type PromptTerm = {
  /** Canonical tag name: underscores, lowercase, no weight or escapes. For a
   * LoRA or embedding, the text as written. */
  name: string;
  /** The name as written. */
  written: string;
  weight?: number;
  kind: "tag" | "lora" | "embedding" | "prose";
  /** The piece in the text, emphasis and weight included. */
  start: number;
  end: number;
  /** Just the name in the text. */
  nameStart: number;
  nameEnd: number;
};

type Span = { text: string; start: number; end: number; weight?: number };

/** Comma (or line) pieces with their place in `text`, keeping a comma inside
 * an emphasis group as part of it. */
export function splitSpans(text: string, offset = 0): Span[] {
  const out: Span[] = [];
  let depth = 0;
  let from = 0;
  const push = (end: number) => {
    const raw = text.slice(from, end);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ text: t, start: offset + from + lead, end: offset + from + lead + t.length });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    if ((c === ")" || c === "]") && depth > 0) depth--;
    if ((c === "," || c === "\n") && depth === 0) {
      push(i);
      from = i + 1;
    }
  }
  push(text.length);
  return out;
}

const WEIGHT = /:\s*(-?[\d.]+)\s*$/;
// This many words or more, and not written as a tag: a sentence fragment.
const PROSE_WORDS = 5;

/** Where the bracket opening `text` closes, or -1. */
function closeOf(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && --depth === 0) return i;
  }
  return -1;
}

/** A group's members as their own pieces, each carrying the group's weight:
 * `(a, b:1.2)` gives `a` and `b`, both at 1.2; `((a, b))` and `[a, b]`
 * unwrap the same way. A bracket around one tag stays its emphasis. */
function unwrap(p: Span): Span[] {
  const t = p.text;
  if (!(t[0] === "(" || t[0] === "[") || closeOf(t) !== t.length - 1) return [p];
  let inner = t.slice(1, -1);
  let weight = p.weight;
  const m = t[0] === "(" ? WEIGHT.exec(inner) : null;
  if (m && m.index > 0) {
    weight = Number(m[1]);
    inner = inner.slice(0, m.index);
  }
  const members = splitSpans(inner, p.start + 1);
  const nested = members.length === 1 && (members[0].text[0] === "(" || members[0].text[0] === "[");
  if (members.length < 2 && !nested) return [p];
  const out = members.flatMap((x) => unwrap({ ...x, weight: x.weight ?? weight }));
  // `((a))`: one tag after all; keep the piece whole so its emphasis stays.
  return out.length === 1 ? [p] : out;
}

function pieces(text: string): Span[] {
  return splitSpans(text).flatMap(unwrap);
}

function readTerm(p: Span): PromptTerm | null {
  const s = p.text;
  const at = { start: p.start, end: p.end };
  if (/^<lora:/i.test(s)) return { name: s, written: s, kind: "lora", ...at, nameStart: p.start, nameEnd: p.end };
  if (/^<?embedding:/i.test(s)) {
    const name = s.replace(/^<|>$/g, "");
    return { name, written: s, kind: "embedding", ...at, nameStart: p.start, nameEnd: p.end };
  }
  // Emphasis: (tag:1.2), ((tag)), [tag]. An escaped paren is part of the name.
  let l = 0;
  let r = s.length;
  while (l < r && (s[l] === "(" || s[l] === "[")) l++;
  while (r > l && (s[r - 1] === ")" || s[r - 1] === "]") && s[r - 2] !== "\\") r--;
  let weight = p.weight;
  // A weight only inside parens: `:3` and `16:9` are names.
  const m = s[0] === "(" ? WEIGHT.exec(s.slice(l, r)) : null;
  if (m && m.index > 0) {
    weight = Number(m[1]);
    r = l + m.index;
  }
  while (l < r && s[l] === " ") l++;
  while (r > l && s[r - 1] === " ") r--;
  const written = s.slice(l, r);
  const name = written.replace(/\\([()])/g, "$1").toLowerCase().replace(/\s+/g, "_");
  if (!name) return null;
  const prose = !written.includes("_") && written.split(/\s+/).length >= PROSE_WORDS;
  return {
    name,
    written,
    weight,
    kind: prose ? "prose" : "tag",
    ...at,
    nameStart: p.start + l,
    nameEnd: p.start + r,
  };
}

/** Every term of a prompt, in order. */
export function promptTerms(text: string): PromptTerm[] {
  return pieces(text).flatMap((p) => readTerm(p) ?? []);
}

/** `text` without the piece at [start, end) and the separator it owned: the
 * comma (or line break) after it, else the one before it. */
export function removeSpan(text: string, start: number, end: number): string {
  const lineStart = start === 0 || text[start - 1] === "\n";
  let e = end;
  while (text[e] === " ") e++;
  if (text[e] === ",") {
    e++;
    while (text[e] === " ") e++;
    // First on its line: its line break goes with it.
    if (lineStart && text[e] === "\n") e++;
    return text.slice(0, start) + text.slice(e);
  }
  if (text[e] === "\n") return text.slice(0, start) + text.slice(e + 1);
  let s = start;
  while (s > 0 && (text[s - 1] === " " || text[s - 1] === "\n")) s--;
  if (text[s - 1] === ",") s--;
  return text.slice(0, s) + text.slice(e);
}

/** How a tag reads in a prompt: spaces, parens escaped. */
export function promptWord(name: string): string {
  return name.replace(/_/g, " ").replace(/([()])/g, "\\$1");
}

/** `text` with a piece (as written) added at the end. */
export function appendPiece(text: string, piece: string): string {
  const head = text.replace(/[,\s]*$/, "");
  return head ? `${head}, ${piece}` : piece;
}

/** `text` with `name` added at the end. */
export function appendTag(text: string, name: string): string {
  return appendPiece(text, promptWord(name));
}

/** `text` with a term's name swapped for `name`, its weight kept. */
export function replaceName(text: string, term: PromptTerm, name: string): string {
  return text.slice(0, term.nameStart) + promptWord(name) + text.slice(term.nameEnd);
}
