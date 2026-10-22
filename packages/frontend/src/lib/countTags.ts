import { canonicalName } from "./tags";

/**
 * Count tags (`1girl`, `2girls`, `1boy`, `solo`, `multiple_girls`) against
 * the characters picked on the Generate page. The models learned Danbooru's
 * convention, so a prompt that says `1girl, solo` for two characters fights
 * itself:
 *
 * - each kind present gets its own count: 1 girl + 1 boy is `1girl, 1boy`,
 *   two girls `2girls, multiple_girls`;
 * - `solo` only with one character; `multiple_girls` / `multiple_boys` only
 *   with two or more of that kind.
 *
 * A character's kind comes from their recipe (`gender`, read from the count
 * tags on their images); one that can't be told (always drawn beside someone
 * of the other kind) is unknown, and then only what is wrong whatever their
 * kind (`solo` with two characters, more people than were picked) is flagged.
 * Only the main prompt is checked: subjects belong there, not in the prefix.
 * Pure.
 */

export type Kind = "girl" | "boy" | "other";

export type CountMark = {
  /** Offsets of the term in the prompt text (trimmed of spaces). */
  start: number;
  end: number;
  /** The term as written. */
  text: string;
  /** Why it's flagged, one plain sentence. */
  reason: string;
};

export type CountCheck = {
  marks: CountMark[];
  /** The count tags the cast calls for, in Danbooru's order; null when a
   * kind is unknown, so there is no full set to offer. */
  expected: string[] | null;
};

const KINDS: readonly Kind[] = ["girl", "boy", "other"];
const COUNT = /^(\d+|6\+)(girl|boy|other)s?$/;

/** A prompt term as a tag: weight and brackets off, spelled as stored
 * (`canonicalName`), `2 girls` and `2_girls` as `2girls`. A term with
 * unbalanced brackets reads as nothing. */
function normalise(term: string): string {
  const opens = (term.match(/[([{]/g) ?? []).length;
  const closes = (term.match(/[)\]}]/g) ?? []).length;
  if (opens !== closes) return "";
  // (1girl:1.2), [solo], {2girls}
  const t = term.toLowerCase().replace(/^\s*[([{]+|[)\]}]+\s*$/g, "").replace(/:[\d.]+$/, "");
  return canonicalName(t).replace(/^(\d+\+?)_(girl|boy|other)/, "$1$2");
}

type Parsed =
  /** `atLeast`: `6+girls`, six or more. */
  | { kind: Kind; n: number; atLeast: boolean }
  | { multiple: "girl" | "boy" }
  | { solo: true };

function parse(tag: string): Parsed | null {
  if (tag === "solo") return { solo: true };
  if (tag === "multiple_girls") return { multiple: "girl" };
  if (tag === "multiple_boys") return { multiple: "boy" };
  const m = COUNT.exec(tag);
  if (!m) return null;
  return { kind: m[2] as Kind, n: m[1] === "6+" ? 6 : Number(m[1]), atLeast: m[1] === "6+" };
}

/** Follows bracket depth across comma-separated pieces: `inGroup(piece)` is
 * true for every piece of a weighted group (`(1girl, solo, smile:1.2)`), its
 * middle terms included, so a group is left whole. A stray closer never
 * takes the depth below zero. */
function groupTracker(): (piece: string) => boolean {
  let depth = 0;
  return (piece) => {
    const before = depth;
    depth = Math.max(0, depth + (piece.match(/[([{]/g) ?? []).length - (piece.match(/[)\]}]/g) ?? []).length);
    return before > 0 || depth > 0;
  };
}

/** The comma-separated terms of `text` outside weighted groups, with their
 * offsets, spaces trimmed. */
function terms(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const inGroup = groupTracker();
  let at = 0;
  for (const piece of text.split(/[,\n]/)) {
    const lead = piece.length - piece.trimStart().length;
    const word = piece.trim();
    if (!inGroup(piece) && word) out.push({ start: at + lead, end: at + lead + word.length, text: word });
    at += piece.length + 1;
  }
  return out;
}

const plural = (n: number, kind: Kind) => `${n >= 6 ? "6+" : n}${kind}${n > 1 ? "s" : ""}`;
const people = (n: number, kind: Kind) => `${n} ${kind}${n === 1 ? "" : "s"}`;

/** The count tags a cast of known kinds calls for. */
export function expectedTags(kinds: readonly Kind[]): string[] {
  const n = (k: Kind) => kinds.filter((x) => x === k).length;
  const out = KINDS.filter((k) => n(k) > 0).map((k) => plural(n(k), k));
  if (n("girl") >= 2) out.push("multiple_girls");
  if (n("boy") >= 2) out.push("multiple_boys");
  if (kinds.length === 1) out.push("solo");
  return out;
}

function castLabel(kinds: readonly Kind[]): string {
  return KINDS.map((k) => [k, kinds.filter((x) => x === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => people(n, k))
    .join(" and ");
}

/** Flag the count tags in `prompt` that don't fit the picked characters
 * (`kinds`, null for one whose kind is unknown). Nothing to check without
 * characters. */
export function checkCountTags(prompt: string, kinds: readonly (Kind | null)[]): CountCheck {
  if (!kinds.length) return { marks: [], expected: null };
  const known = kinds.every((k) => k !== null) ? (kinds as Kind[]) : null;
  const count = (k: Kind) => kinds.filter((x) => x === k).length;
  const cast = known
    ? castLabel(known)
    : `${kinds.length} ${kinds.length === 1 ? "character" : "characters"}`;
  const marks: CountMark[] = [];
  for (const t of terms(prompt)) {
    const p = parse(normalise(t.text));
    if (!p) continue;
    let reason: string | null = null;
    if ("solo" in p) {
      if (kinds.length > 1) reason = `${cast} are picked, so this isn't a solo image.`;
    } else if ("multiple" in p) {
      if (known && count(p.multiple) < 2) reason = `Only for 2 or more ${p.multiple}s; the cast is ${cast}.`;
    } else if (p.n > kinds.length) {
      reason = `Says ${people(p.n, p.kind)}, but only ${cast} ${kinds.length === 1 ? "is" : "are"} picked.`;
    } else if (known && (p.atLeast ? count(p.kind) < p.n : count(p.kind) !== p.n)) {
      reason = count(p.kind)
        ? `The cast has ${people(count(p.kind), p.kind)}, not ${p.n}.`
        : `No ${p.kind} is picked; the cast is ${cast}.`;
    }
    if (reason) marks.push({ ...t, reason });
  }
  return { marks, expected: known ? expectedTags(known) : null };
}

/**
 * `prompt` with every count tag replaced by `expected`, written where the
 * first one stood (or at the start when there was none). Other terms, their
 * separators and spacing are kept.
 */
export function fixCountTags(prompt: string, expected: readonly string[]): string {
  const words = expected.join(", ");
  // Pieces at even indexes, the separator after each at odd ones.
  const parts = prompt.split(/([,\n])/);
  const kept: string[] = [];
  let placed = false;
  const inGroup = groupTracker();
  for (let i = 0; i < parts.length; i += 2) {
    const piece = parts[i];
    const sep = parts[i + 1] ?? "";
    if (!inGroup(piece) && piece.trim() && parse(normalise(piece))) {
      // Dropped with its comma; a line break stays a line break.
      if (placed || !words) {
        if (sep === "\n") kept.push(sep);
        continue;
      }
      placed = true;
      kept.push(piece.match(/^\s*/)![0] + words + sep);
    } else {
      kept.push(piece + sep);
    }
  }
  let out = kept.join("");
  // A removed last term leaves its separator behind.
  if (!/[,\n]\s*$/.test(prompt)) out = out.replace(/[,\n]\s*$/, "");
  out = out.replace(/^\s*,\s*/, "");
  if (!placed && words) return out.trim() ? `${words}, ${out.trimStart()}` : words;
  return out;
}

/** Where the count tags sit in `prompt` (outside weighted groups), spelled as
 * stored. */
export function countRanges(prompt: string): { start: number; end: number; tag: string }[] {
  return terms(prompt).flatMap((t) => {
    const tag = normalise(t.text);
    return parse(tag) ? [{ start: t.start, end: t.end, tag }] : [];
  });
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * The prompt with its count tags following the cast: when the cast's set
 * goes from `before` to `after`, tags that are still `before` (or no count
 * tags at all) become `after`, where they stood or at the start. Count tags
 * the user wrote themselves (anything but `before`) are theirs: left alone,
 * and the check flags them if they don't fit. Null when nothing changes.
 */
export function followCast(prompt: string, before: readonly string[], after: readonly string[]): string | null {
  const now = countRanges(prompt).map((r) => r.tag);
  if (now.length && !sameSet(now, before)) return null;
  if (sameSet(now, after)) return null;
  const out = fixCountTags(prompt, after);
  return after.length ? out : out.trimStart();
}
