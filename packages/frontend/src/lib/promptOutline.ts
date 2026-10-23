/**
 * Generate's Prompt read as terms for the prompt board: each piece with
 * where it sits in the text, its tag name and its weight, so the board can
 * place it (`/tags/place`), take it out, or swap an alias for its tag without
 * touching the rest of what was written. Pure.
 *
 * The frontend's one prompt splitter, a port of the backend's
 * `services/prompt_parse.py` (scan, clean, classify) that also keeps where
 * each piece sits. The backend writes the prompt tags, so it is the
 * authority: both are checked against
 * `packages/backend/tests/fixtures/mirrored/prompt_terms.json`.
 */
import { KAOMOJIS, canonicalName } from "./tags";

export type PromptTerm = {
  /** Canonical tag name: underscores, lowercase, no weight, escapes or edge
   * punctuation. For a LoRA or embedding, the text as written. */
  name: string;
  /** The name as written. */
  written: string;
  weight?: number;
  /** "noise": leaked settings, a lone joiner or a stray weight; in the
   * prompt, never a tag. */
  kind: "tag" | "lora" | "embedding" | "prose" | "noise";
  /** The piece in the text, emphasis and weight included. */
  start: number;
  end: number;
  /** Just the name in the text. */
  nameStart: number;
  nameEnd: number;
  /** Shares a group with other terms (`(a, b:1.2)`), or sits in one left
   * open. A group around this term alone is part of its piece instead. */
  grouped: boolean;
};

/** What separates terms, besides `BREAK` / `AND` and an escaped comma. */
export const SEPARATORS = new Set([",", "\n", "|"]);
const KEYWORDS = ["BREAK", "AND"];
const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

// A `:weight` suffix (`tag:1.2`), or only a decimal one (`smile:1.05`).
const WEIGHT_TAIL = /\s*:\s*-?\d*\.?\d+\s*$/;
const DECIMAL_WEIGHT_TAIL = /\s*:\s*(-?\d*\.\d+)\s*$/;
const GROUP_WEIGHT = /:\s*(-?\d*\.?\d+)\s*$/;
const EDGE_PUNCT = " \t.;:!?\"'`";
const SETTINGS_KEY =
  /^(?:vae|steps|sampler|scheduler|cfg(?: scale)?|seed|size|model(?: hash)?|clip skip|denoising strength|hires (?:upscale|steps|upscaler)|lora hashes|version|ensd|width|height)\s*:/;
const NEG_MARKER = /\bnegative prompt\s*:\s*/g;
const JOINERS = new Set(["and", "or", "with", "a", "an", "the", "of", "in", "on", "by", "-"]);
const PROSE_WORDS = new Set([
  "a", "an", "the", "she", "he", "her", "his", "they", "their", "is", "are",
  "was", "has", "wears", "stands", "sits", "sitting", "standing",
]);
const ABBREV = new Set(["st", "jr", "sr", "dr", "mr", "mrs", "ms", "vs", "ver", "vol", "no", "feat"]);
const SENTENCE_END = /\b([a-z]{2,})\.(?=\s|$)/g;
// All punctuation, so matched whole before any bracket, colon or separator
// rule can take them apart.
const EMOTICONS = new Set([
  ...KAOMOJIS,
  ":d", ":o", ":3", ";d", ":<", ":p", ":q", ":t", ";)", ":>", ">:)", ":/",
  ";o", "d:", ":|", "3:", ";p", ">:(", ":>=", ";q", ":i", ";3", ":x", ";(",
  ">o<", "^^^", "+++", "\\m/", "\\o/", "\\n/", "\\||/", "...", "...?",
  "?", "!", "!?", "!!", "??",
]);
const EMOTICON_MAX = Math.max(...[...EMOTICONS].map((e) => e.length));
const NETWORK_TOKEN = /<(?:lora|lyco|lycoris|hypernet|embedding|wlr):[^<>,\n]*>/iy;
const NETWORK_PREFIX = /^(?:<(?:lora|lyco|lycoris|hypernet|embedding|wlr):|embedding:)/i;
const EMBEDDING_TOKEN = /embedding:([^\s,()[\]{}<>|:]+)(?::(-?\d*\.?\d+)(?=\s*[)\]},]|\s*$))?/iy;
const LEAD_JOINER = /^(?:and|or)\s+/i;
const QUALIFIER = /\([^()]*\)/g;
// Sticky: tested at an offset, so the rest of the prompt is never copied.
const WEIGHT_AHEAD = /\s*-?\d*\.?\d+\s*(?:[)\]},]|$)/y;

const isSpace = (c: string) => /\s/.test(c);
const isAlnum = (c: string) => /[\p{L}\p{N}]/u.test(c);
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function strip(s: string, chars: string): string {
  let l = 0;
  let r = s.length;
  while (l < r && chars.includes(s[l])) l++;
  while (r > l && chars.includes(s[r - 1])) r--;
  return s.slice(l, r);
}

type Group = {
  open: number;
  /** Where it closes, or -1 when it never does. */
  close: number;
  parent: Group | null;
  weight?: number;
  /** Terms inside it, nested ones included. */
  terms: number;
  /** `[from:to:0.5]`: prompt editing, not emphasis. */
  edit?: boolean;
  /** Where the last emoticon read in it starts. */
  emoticon?: number;
};

/** A piece as scanned: its characters (escapes resolved), where each came
 * from in the text, and the innermost group it sat in. */
type Raw = { chars: string[]; from: number[]; to: number[]; group: Group | null };

/** If the `(` at `i` opens a Danbooru qualifier, the index just past its
 * `)`; else -1. Unweighted, flat and short: `(genshin_impact)`. */
function qualifierEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === ")") {
      const inner = text.slice(i + 1, j);
      if (!inner.trim() || inner.includes(":") || inner.trim().split(/\s+/).length > 6) return -1;
      return j + 1;
    }
    if (SEPARATORS.has(c) || OPEN.has(c) || CLOSE.has(c) || c === "\\") return -1;
  }
  return -1;
}

/** Length of a `BREAK` / `AND` keyword standing alone at `i`, else 0. */
function keywordAt(text: string, i: number): number {
  for (const kw of KEYWORDS) {
    const j = i + kw.length;
    if (text.startsWith(kw, i) && (i === 0 || !isAlnum(text[i - 1])) && (j === text.length || !isAlnum(text[j]))) {
      return kw.length;
    }
  }
  return 0;
}

const sticky = (re: RegExp, text: string, i: number) => {
  re.lastIndex = i;
  return re.exec(text);
};

/** Length of the longest emoticon at `i` that ends at a boundary, else 0. */
function emoticonAt(text: string, i: number): number {
  const n = text.length;
  for (let length = Math.min(EMOTICON_MAX, n - i); length > 0; length--) {
    if (!EMOTICONS.has(text.slice(i, i + length).toLowerCase())) continue;
    const j = i + length;
    if (
      j === n ||
      SEPARATORS.has(text[j]) ||
      CLOSE.has(text[j]) ||
      isSpace(text[j]) ||
      (text[j] === ":" && !!sticky(WEIGHT_AHEAD, text, j + 1))
    ) {
      return length;
    }
  }
  return 0;
}

/** The raw pieces of `text`, cut at separators and at group edges, as
 * `prompt_parse._scan` cuts them. */
function scan(text: string): Raw[] {
  const pieces: Raw[] = [];
  let buf: Raw = { chars: [], from: [], to: [], group: null };
  let hasText = false;
  const stack: Group[] = [];
  const top = () => stack[stack.length - 1] ?? null;
  const add = (c: string, from: number, to: number) => {
    buf.chars.push(c);
    buf.from.push(from);
    buf.to.push(to);
  };
  const flush = () => {
    if (buf.chars.length) pieces.push({ ...buf, group: top() });
    buf = { chars: [], from: [], to: [], group: null };
    hasText = false;
  };
  const emit = (at: number, raw: string) => {
    flush();
    for (let k = 0; k < raw.length; k++) add(raw[k], at + k, at + k + 1);
    flush();
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (!hasText) {
      if (isSpace(c)) {
        i++;
        continue;
      }
      const length = emoticonAt(text, i);
      if (length) {
        if (top()) top()!.emoticon = i;
        emit(i, text.slice(i, i + length));
        i += length;
        continue;
      }
    }
    const kw = keywordAt(text, i);
    if (kw) {
      flush();
      i += kw;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      // An escaped comma still separates: a tag never holds one.
      if (text[i + 1] === ",") flush();
      else {
        add(text[i + 1], i, i + 2);
        hasText = true;
      }
      i += 2;
      continue;
    }
    if ((c === "e" || c === "E") && (i === 0 || !(isAlnum(text[i - 1]) || text[i - 1] === "_"))) {
      const m = sticky(EMBEDDING_TOKEN, text, i);
      if (m) {
        emit(i, m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (c === "<") {
      const m = sticky(NETWORK_TOKEN, text, i);
      if (m) {
        emit(i, m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (SEPARATORS.has(c)) {
      flush();
      i++;
      continue;
    }
    if (c === "(" && hasText && !isSpace(buf.chars[buf.chars.length - 1])) {
      // Glued onto a name, a Danbooru qualifier; after a space, emphasis.
      const end = qualifierEnd(text, i);
      if (end >= 0) {
        for (let k = i; k < end; k++) add(text[k], k, k + 1);
        i = end;
        continue;
      }
    }
    if (OPEN.has(c)) {
      flush();
      stack.push({ open: i, close: -1, parent: top(), terms: 0 });
      i++;
      continue;
    }
    if (CLOSE.has(c)) {
      // Closes a group, or is a stray: a boundary either way.
      flush();
      const g = stack.pop();
      if (g) {
        g.close = i;
        // Only `(...)` carries a weight, written last: `(a, b:1.2)`. A last
        // member that is an emoticon (`(a, :3)`) is a member, not a weight.
        const m = text[g.open] === "(" ? GROUP_WEIGHT.exec(text.slice(g.open + 1, i)) : null;
        if (m && m.index > 0 && g.emoticon !== g.open + 1 + m.index) g.weight = Number(m[1]);
      }
      i++;
      continue;
    }
    if (c === ":" && top() && text[top()!.open] === "[" && hasText) {
      // `[from:to:0.5]` (prompt editing): the two sides are separate pieces.
      if (!sticky(WEIGHT_AHEAD, text, i + 1)) {
        top()!.edit = true;
        flush();
        i++;
        continue;
      }
    }
    add(c, i, i + 1);
    if (!isSpace(c)) hasText = true;
    i++;
  }
  flush();
  return pieces;
}

/** A sentence fragment rather than a tag: 9+ words, or 5+ with a sentence
 * end or a prose word. Words in `(...)` qualifiers don't count. */
function isProse(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  const words = text.replace(QUALIFIER, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 9) return true;
  if (words.length < 5) return false;
  for (const m of text.matchAll(SENTENCE_END)) if (!ABBREV.has(m[1])) return true;
  return words.some((w) => PROSE_WORDS.has(strip(w, ".,!?'\"")));
}

function classify(name: string, raw: string): "tag" | "prose" | "noise" | "network" {
  if (NETWORK_PREFIX.test(name)) return "network";
  if (EMOTICONS.has(name)) return "tag";
  if (!name || JOINERS.has(name) || !/[\p{L}\p{N}]/u.test(name)) return "noise";
  if (/^-?\d*\.\d+$/.test(name)) return "noise";
  if (SETTINGS_KEY.test(name)) return "noise";
  return isProse(raw) ? "prose" : "tag";
}

/** A scanned piece as a term (`prompt_parse._clean` with offsets), or null
 * when nothing is left of it. The window [l, r) over its characters shrinks
 * as edges are cleaned off; the name is read from what is left. */
function readTerm(text: string, p: Raw): PromptTerm | null {
  const { chars } = p;
  const inGroup = p.group !== null;
  let l = 0;
  let r = chars.length;
  while (l < r && isSpace(chars[l])) l++;
  while (r > l && isSpace(chars[r - 1])) r--;
  const start = l;
  let end = r;
  // Outside a group, a decimal weight written bare (`smile:1.05`) is the
  // piece's own.
  let own: number | undefined;
  const win = () => chars.slice(l, r).join("");
  const read = () =>
    collapse(win())
      .toLowerCase()
      .replace(/\s+\)/g, ")")
      .replace(/\(\s+/g, "(")
      .replace(NEG_MARKER, "");
  let name = collapse(win()).toLowerCase();
  if (!(name.startsWith("<") || EMOTICONS.has(name))) {
    const lead = LEAD_JOINER.exec(win()) ?? /^negative\s+prompt\s*:\s*/i.exec(win());
    if (lead) l += lead[0].length;
    if (!SETTINGS_KEY.test(read())) {
      const w = (inGroup ? WEIGHT_TAIL : DECIMAL_WEIGHT_TAIL).exec(win());
      if (w) {
        r -= w[0].length;
        // Inside a group the weight is the group's, not this piece's.
        if (inGroup) end = r;
        else own = Number(w[1]);
      }
      while (l < r && EDGE_PUNCT.includes(chars[l])) l++;
      while (r > l && EDGE_PUNCT.includes(chars[r - 1])) r--;
    }
    name = l < r ? read() : "";
  }
  if (!name) return null;
  const nameStart = p.from[l];
  const nameEnd = p.to[r - 1];
  const written = text.slice(nameStart, nameEnd);
  let weight = own;
  for (let g = p.group; g && weight === undefined; g = g.parent) weight = g.weight;
  const at = { start: p.from[start], end: p.to[end - 1], nameStart, nameEnd, weight, grouped: inGroup };
  const kind = classify(name, chars.join(""));
  if (kind === "network") {
    if (/^<?embedding:/i.test(written)) return { name: written.replace(/^<|>$/g, ""), written, kind: "embedding", ...at };
    return { name: written, written, kind: "lora", ...at };
  }
  return { name: canonicalName(name), written, kind, ...at };
}

type Placed = { term: PromptTerm; group: Group | null };

/** Every term with the group it is a member of (null at the top level). */
function placeTerms(text: string): Placed[] {
  const placed: Placed[] = [];
  for (const p of scan(text)) {
    const term = readTerm(text, p);
    if (!term) continue;
    for (let g = p.group; g; g = g.parent) g.terms++;
    placed.push({ term, group: p.group });
  }
  return placed.map(({ term, group }) => {
    let g = group;
    let { start, end } = term;
    while (g && g.close >= 0 && g.terms === 1) {
      start = g.open;
      end = g.close + 1;
      g = g.parent;
    }
    return { term: { ...term, start, end, grouped: g !== null }, group: g };
  });
}

/** Every term of a prompt, in order. A group holding one term alone (`(a:1.2)`,
 * `((a))`) is that term's piece; members of a larger group are their own,
 * each carrying the group's weight. */
export function promptTerms(text: string): PromptTerm[] {
  return placeTerms(text).map((p) => p.term);
}

/** Where the run of separators (spaces, `,` `\n` `|`, an escaped comma,
 * `BREAK` / `AND`) after `i` ends. */
function runAfter(text: string, i: number): number {
  for (;;) {
    if (i < text.length && (isSpace(text[i]) || SEPARATORS.has(text[i]))) i++;
    else if (text.startsWith("\\,", i)) i += 2;
    else if (keywordAt(text, i)) i += keywordAt(text, i);
    else return i;
  }
}

/** Where the run of separators before `i` starts. */
function runBefore(text: string, i: number): number {
  for (;;) {
    if (i > 0 && (isSpace(text[i - 1]) || SEPARATORS.has(text[i - 1]))) {
      i--;
      if (text[i] === "," && text[i - 1] === "\\") i--;
      continue;
    }
    const kw = KEYWORDS.find((k) => i >= k.length && keywordAt(text, i - k.length) === k.length);
    if (!kw) return i;
    i -= kw.length;
  }
}

// A run holds only separators, so a keyword in it is one standing alone.
const hasKeyword = (run: string) => KEYWORDS.some((k) => run.includes(k));
// What a run keeps apart: a line, `BREAK` or `AND` most, then `|`, then a comma.
const strength = (run: string) =>
  run.includes("\n") || hasKeyword(run) ? 3 : run.includes("|") ? 2 : run.includes(",") ? 1 : 0;
const leadSpace = (run: string) => run.length - run.trimStart().length;
const trailSpace = (run: string) => run.length - run.trimEnd().length;
// Nothing before or after in this group (or the prompt): its edge.
const edgeBefore = (text: string, i: number) => i === 0 || (OPEN.has(text[i - 1]) && text[i - 2] !== "\\");
const edgeAfter = (text: string, i: number) =>
  i === text.length || CLOSE.has(text[i]) || (text[i] === ":" && !!sticky(WEIGHT_AHEAD, text, i + 1));

/** `text` without [s, e) and the separators it owns. Between two terms it
 * takes the weaker of the runs on its sides, so the stronger one still
 * stands between them; first or last in its group (or the prompt), the run
 * on its inner side, so no `,` `|` `BREAK` is left dangling. Spaces at the
 * very edge and a trailing separator the prompt was written with stay. */
function cut(text: string, s: number, e: number): string {
  const b = runBefore(text, s);
  const a = runAfter(text, e);
  const before = text.slice(b, s);
  const after = text.slice(e, a);
  const first = edgeBefore(text, b);
  const last = edgeAfter(text, a);
  let from = s;
  let to = e;
  if (first) {
    from = b + leadSpace(before);
    to = last ? a - trailSpace(after) : a;
  } else if (last) {
    from = b;
    to = hasKeyword(after) ? a - trailSpace(after) : e;
  } else if (strength(before) >= strength(after)) {
    to = a;
  } else {
    from = b;
  }
  return text.slice(0, from) + text.slice(to);
}

/**
 * `text` without the terms at `ranges` (spans from promptTerms; any other
 * span is cut as it stands) and the separators each owned, the rest as
 * written. A group goes whole once every member goes; while one is left it
 * keeps its weight. A prompt edit (`[from:to:0.5]`) goes whole when either
 * side does: one side alone would turn it into a weight. Pure.
 */
export function removeTerms(text: string, ranges: readonly { start: number; end: number }[]): string {
  const placed = placeTerms(text);
  const hit = new Set<Placed>();
  const spans: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const p = placed.find((x) => x.term.start === r.start && x.term.end === r.end);
    if (p) hit.add(p);
    else spans.push({ start: r.start, end: r.end });
  }
  const chain = (g: Group | null) => {
    const out: Group[] = [];
    for (; g; g = g.parent) out.push(g);
    return out;
  };
  const gone = new Map<Group, boolean>();
  // A term is out when it was hit or a group around it (below `g`) goes.
  const out = (p: Placed, g: Group): boolean => {
    const around = chain(p.group);
    return hit.has(p) || around.slice(0, around.indexOf(g)).some(isGone);
  };
  function isGone(g: Group): boolean {
    let v = gone.get(g);
    if (v === undefined) {
      const members = placed.filter((p) => chain(p.group).includes(g));
      v = g.close >= 0 && members.length > 0 && (g.edit ? members.some((p) => out(p, g)) : members.every((p) => out(p, g)));
      gone.set(g, v);
    }
    return v;
  }
  for (const p of placed) {
    const groups = chain(p.group).filter(isGone);
    const top = groups[groups.length - 1];
    if (top) spans.push({ start: top.open, end: top.close + 1 });
    else if (hit.has(p)) spans.push(p.term);
  }
  // From the end, so the earlier offsets still hold; a span inside one
  // already cut is gone with it.
  spans.sort((x, y) => y.start - x.start || y.end - x.end);
  let res = text;
  let floor = Infinity;
  for (const { start, end } of spans) {
    if (end > floor) continue;
    res = cut(res, start, end);
    floor = start;
  }
  return res;
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
