/**
 * Boilerplate tags: the ones that ride along on nearly every prompt and say
 * nothing about the image ("masterpiece", "best quality", "score_9"). The UI
 * folds them away and ranks them last; search and filters never change.
 *
 * The list lives in Settings (`/tags/settings`, services/tag_settings.py).
 * An entry matches a tag's *name* from any source (AI, manual, prompt, and
 * the gallery search's merged `any:` entries); `*` is a wildcard; case, and
 * spaces vs underscores, don't matter ("best_quality" = "Best Quality").
 */

import { ANY_PREFIX, MANUAL_PREFIX, PROMPT_PREFIX } from "./tags";

const PREFIXES = [ANY_PREFIX, MANUAL_PREFIX, PROMPT_PREFIX];

/** The comparable form of a tag or a list entry: no source prefix,
 * lowercase, runs of spaces/underscores as one space. */
export function normalizeTagName(raw: string): string {
  let s = raw;
  for (const p of PREFIXES) {
    if (s.startsWith(p)) {
      s = s.slice(p.length);
      break;
    }
  }
  return s.toLowerCase().replace(/[\s_]+/g, " ").trim();
}

export type BoilerplateMatcher = (rawTag: string) => boolean;

/** Never matches: the state before settings load, or an empty list. */
export const NO_BOILERPLATE: BoilerplateMatcher = () => false;

/** Compile the list once; exact entries are a set lookup, wildcard entries
 * one anchored regex each. */
export function compileBoilerplate(entries: readonly string[]): BoilerplateMatcher {
  const exact = new Set<string>();
  const globs: RegExp[] = [];
  for (const e of entries) {
    const n = normalizeTagName(e);
    if (!n || n.replace(/[*\s]/g, "") === "") continue;
    if (!n.includes("*")) {
      exact.add(n);
      continue;
    }
    const body = n
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    globs.push(new RegExp(`^${body}$`));
  }
  if (!exact.size && !globs.length) return NO_BOILERPLATE;
  return (raw) => {
    const n = normalizeTagName(raw);
    return exact.has(n) || globs.some((re) => re.test(n));
  };
}

/** Split `items` into the ones worth showing and the boilerplate, keeping
 * order within each. */
export function splitBoilerplate<T>(
  items: readonly T[],
  rawOf: (item: T) => string,
  isBoilerplate: BoilerplateMatcher,
): { kept: T[]; boilerplate: T[] } {
  const kept: T[] = [];
  const boilerplate: T[] = [];
  for (const it of items) (isBoilerplate(rawOf(it)) ? boilerplate : kept).push(it);
  return { kept, boilerplate };
}
