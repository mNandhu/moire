import { promptTerms, removeTerms } from "./promptOutline";

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

type CountMark = {
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

/** A term's tag name with `2 girls` and `2_girls` read as `2girls`. */
const normalise = (name: string) => name.replace(/^(\d+\+?)_(girl|boy|other)/, "$1$2");

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

/** The prompt's terms as the board reads them (promptOutline), with their
 * offsets: a weighted or bracketed term alone (`(1girl:1.2)`, `[solo]`)
 * counts, a member of a larger group (`(1girl, solo, smile:1.2)`) doesn't,
 * so a group is left whole. */
function terms(text: string) {
  return promptTerms(text)
    .filter((t) => !t.grouped && t.kind !== "lora" && t.kind !== "embedding")
    .map((t) => ({
      start: t.start,
      end: t.end,
      nameStart: t.nameStart,
      nameEnd: t.nameEnd,
      text: text.slice(t.start, t.end),
      tag: normalise(t.name),
    }));
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
    const p = parse(t.tag);
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
    if (reason) marks.push({ start: t.start, end: t.end, text: t.text, reason });
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
  const found = terms(prompt).filter((t) => parse(t.tag));
  if (!found.length) {
    if (!words) return prompt;
    return prompt.trim() ? `${words}, ${prompt.trimStart()}` : words;
  }
  // The first takes the new names inside its own brackets and weight; the
  // rest go with their separators (removeTerms, which leaves the first's
  // offsets alone: it stands before them all).
  const keep = words ? found[0] : null;
  const out = removeTerms(prompt, found.filter((t) => t !== keep));
  return keep ? out.slice(0, keep.nameStart) + words + out.slice(keep.nameEnd) : out;
}

/** Where the count tags sit in `prompt` (outside weighted groups), spelled as
 * stored. */
export function countRanges(prompt: string): { start: number; end: number; tag: string }[] {
  return terms(prompt).flatMap(({ start, end, tag }) => (parse(tag) ? [{ start, end, tag }] : []));
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
