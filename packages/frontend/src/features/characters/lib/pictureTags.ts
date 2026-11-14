/**
 * Filling a new character's tag lists from a tagged picture. Pure.
 */

/** Most tags one picture puts in a list (as the recipe's own signature caps). */
const PICTURE_TAG_LIMIT = 12;

/**
 * `current` with the previous picture's tags swapped for the next one's:
 * tags the user added by hand stay, what the last picture put in goes
 * (a second picture replaces the first), and the new picture's tags join at
 * the end, each once, at most `limit` of them, none already in `taken`.
 * Returns the list and what this picture added (the next call's `previous`).
 */
export function refill(
  current: readonly string[],
  previous: readonly string[],
  next: readonly string[],
  taken: ReadonlySet<string> = new Set(),
  limit = PICTURE_TAG_LIMIT,
): { tags: string[]; added: string[] } {
  const was = new Set(previous);
  const kept = current.filter((t) => !was.has(t));
  const have = new Set([...kept, ...taken]);
  const added: string[] = [];
  for (const t of next) {
    if (added.length >= limit) break;
    if (t && !have.has(t)) {
      have.add(t);
      added.push(t);
    }
  }
  return { tags: [...kept, ...added], added };
}

/** Pasted text that is a single http(s) link, else null. */
export function pastedLink(text: string): string | null {
  const t = text.trim();
  return /^https?:\/\/\S+$/i.test(t) ? t : null;
}
