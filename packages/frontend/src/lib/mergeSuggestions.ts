import type { MergeKind, MergeSuggestion } from "./queries";

/** Shown in this order, most certain first (services/tag_canon.py stages). */
export const KIND_ORDER: readonly MergeKind[] = ["alias", "respell", "colour", "split", "strip"];

export const KIND_LABEL: Record<MergeKind, string> = {
  alias: "Danbooru aliases",
  respell: "Spelling",
  colour: "Colour",
  split: "Splits",
  strip: "Colour dropped",
};

export const KIND_TIP: Record<MergeKind, string> = {
  alias: "Danbooru's own name for it",
  respell: "The same words, spelled the way Danbooru does",
  colour: "The colour and the thing as one Danbooru tag",
  split: "A Danbooru tag for each describing word",
  strip: "Danbooru has no tag with this colour, so the colour goes",
};

/** Ticked at first: all but a dropped colour, which loses a word. */
export function defaultPicked(list: readonly MergeSuggestion[]): Set<string> {
  return new Set(list.filter((s) => s.kind !== "strip").map((s) => s.from));
}

/** Ticks for a new list: kept as the user left them for names already shown,
 * the default for names new to it. */
export function reconcilePicked(
  picked: ReadonlySet<string>,
  before: readonly MergeSuggestion[],
  next: readonly MergeSuggestion[],
): Set<string> {
  const seen = new Set(before.map((s) => s.from));
  const defaults = defaultPicked(next);
  return new Set(
    next.filter((s) => (seen.has(s.from) ? picked.has(s.from) : defaults.has(s.from))).map((s) => s.from),
  );
}

/** The suggestions by kind, in {@link KIND_ORDER}, empty kinds left out. */
export function groupByKind(
  list: readonly MergeSuggestion[],
): { kind: MergeKind; rows: MergeSuggestion[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, rows: list.filter((s) => s.kind === kind) })).filter(
    (g) => g.rows.length > 0,
  );
}
