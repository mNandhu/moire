/** Whether two lists hold the same items in the same order. */
export function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * `entries` with each comma-separated piece of `text` appended: a piece goes
 * through `toEntry` (null drops it) and is skipped when its `keyOf` already
 * matches an entry or an earlier piece. Pure.
 */
export function addPieces(
  entries: readonly string[],
  text: string,
  toEntry: (piece: string) => string | null,
  keyOf: (entry: string) => string = (e) => e,
): string[] {
  const known = new Set(entries.map(keyOf));
  const next = [...entries];
  for (const piece of text.split(",")) {
    const entry = toEntry(piece);
    if (entry === null) continue;
    const key = keyOf(entry);
    if (known.has(key)) continue;
    known.add(key);
    next.push(entry);
  }
  return next;
}
