/**
 * The prompt board's model: which box each term of the Prompt (and of the
 * other layers) sits in, which tags repeat, what each box suggests. Pure;
 * `components/generate/PromptBoard.tsx` draws it.
 */
import type { CharacterEntry } from "./character";
import type { PromptTerm } from "./promptOutline";
import type { BoardSection, TagPlace } from "./queries";

/** A board box: a server section, or one the prompt's own syntax decides. */
export type BoxKey = BoardSection | "prose" | "resources";

// `expected` boxes read as Missing when empty; `always` ones just show.
export const BOXES: { key: BoxKey; label: string; expected?: boolean; always?: boolean }[] = [
  { key: "subject", label: "Subject", expected: true },
  { key: "hair", label: "Hair", expected: true },
  { key: "eyes", label: "Eyes & gaze", expected: true },
  { key: "expression", label: "Expression", expected: true },
  { key: "body", label: "Body", always: true },
  { key: "attire", label: "Attire", expected: true },
  { key: "pose", label: "Pose & action", expected: true },
  { key: "framing", label: "Framing", expected: true },
  { key: "background", label: "Background", expected: true },
  { key: "lighting", label: "Lighting", expected: true },
  { key: "style", label: "Style" },
  { key: "other", label: "Other" },
  { key: "quality", label: "Quality" },
  { key: "resources", label: "LoRAs & embeddings" },
  { key: "prose", label: "Prose" },
];
// Boxes a tag can be typed into.
export const ADDABLE = new Set<BoxKey>(["subject", "hair", "eyes", "expression", "body", "attire", "pose", "framing", "background", "lighting", "style", "other"]);
// Boxes a Clear empties: the typed-into ones and the not-Danbooru ones.
export const CLEARABLE = new Set<BoxKey>([...ADDABLE, "library", "unknown"]);

/** One of a layer's tags. `onToggle` strikes it out (or brings it back)
 * where the layer keeps it: a recipe's identity, an outfit pick. */
export type LayerTag = { tag: string; dropped?: boolean; onToggle?: () => void; self?: boolean };

/** A layer other than the Prompt: a character (their recipe's tags, shown
 * in each box beside their avatar) or a text layer (prefix, preset). What
 * it covers keeps a part from reading as missing. */
export type BoardLayer = {
  key: string;
  label: string;
  character?: CharacterEntry;
  text?: string;
  tags?: LayerTag[];
  /** Strikes several of its tags at once (one state update, so none is lost); returns the undo. */
  onStrike?: (tags: string[]) => () => void;
};

export type Placed = PromptTerm & { box: BoxKey; place?: TagPlace; dropped?: boolean; self?: boolean; onToggle?: () => void };
export type Cover = { layer: BoardLayer; terms: Placed[] };

/** The tag a term stands for: an alias's own tag. */
export const tagOf = (t: Placed) => t.place?.alias_of ?? t.name;

/** A layer tag as a term (it has no place in the Prompt's text). */
export function layerTerm(t: LayerTag): PromptTerm & Pick<Placed, "dropped" | "self" | "onToggle"> {
  return { name: t.tag.toLowerCase(), written: t.tag.replace(/_/g, " "), kind: "tag", start: -1, end: -1, nameStart: -1, nameEnd: -1, grouped: false, dropped: t.dropped, self: t.self, onToggle: t.onToggle };
}

export function boxOf(t: PromptTerm, place: TagPlace | undefined, boilerplate: (n: string) => boolean): BoxKey {
  if (t.kind === "lora" || t.kind === "embedding") return "resources";
  if (t.kind === "prose" || t.kind === "noise") return "prose";
  if (boilerplate(t.name) || boilerplate(place?.alias_of ?? "")) return "quality";
  return place?.section ?? "other";
}

/** Terms with where each belongs: its place (from `/tags/place`) and box. */
export function placeTerms(
  terms: readonly (PromptTerm & Partial<Placed>)[],
  places: Record<string, TagPlace> | undefined,
  boilerplate: (n: string) => boolean,
): Placed[] {
  return terms.map((t) => {
    const place = places?.[t.name];
    return { ...t, place, box: boxOf(t, place, boilerplate) };
  });
}

/** Tags that appear more than once across the Prompt and the layers (an
 * alias counts as its tag; a struck-out one does not). */
export function repeatedTags(placed: readonly Placed[]): Set<string> {
  const seen = new Map<string, number>();
  for (const t of placed) if (!t.dropped) seen.set(tagOf(t), (seen.get(tagOf(t)) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

export function groupByBox(placed: readonly Placed[]): Map<BoxKey, Placed[]> {
  const out = new Map<BoxKey, Placed[]>();
  for (const t of placed) {
    const list = out.get(t.box);
    if (list) list.push(t);
    else out.set(t.box, [t]);
  }
  return out;
}

/** The layers' terms in a box. The character's own tag is filed here but
 * never drawn: a row of only that would be an avatar and a name with
 * nothing after them. */
export function coversOf(layers: readonly Cover[], box: BoxKey): Cover[] {
  return layers.flatMap((l) => {
    const terms = l.terms.filter((t) => t.box === box && !t.self);
    return terms.length ? [{ layer: l.layer, terms }] : [];
  });
}

/** Per layer, the tags in a box still on and strikable (what a Clear strikes). */
export function liveStrikes(layers: readonly Cover[], box: BoxKey): { layer: BoardLayer; tags: string[] }[] {
  return layers.map((l) => ({ layer: l.layer, tags: l.terms.filter((t) => t.box === box && !t.dropped && !t.self && t.onToggle).map((t) => t.name) }));
}

/** Whether a Clear on this box would take anything out. */
export function isClearable(box: BoxKey, byBox: ReadonlyMap<BoxKey, readonly Placed[]>, layers: readonly Cover[]): boolean {
  return CLEARABLE.has(box) && ((byBox.get(box)?.length ?? 0) > 0 || liveStrikes(layers, box).some((l) => l.tags.length > 0));
}

/** Each box's suggestions: the tags not yet in the Prompt, the library's
 * most used first, then Danbooru's most posted. */
export function rankOptions(
  offers: Partial<Record<BoardSection, [string, number][]>> | undefined,
  present: ReadonlySet<string>,
  counts: ReadonlyMap<string, number>,
): Map<BoxKey, { _id: string; count: number }[]> {
  const out = new Map<BoxKey, { _id: string; count: number }[]>();
  for (const [k, list] of Object.entries(offers ?? {}) as [BoardSection, [string, number][]][]) {
    out.set(
      k,
      list
        .filter(([n]) => !present.has(n))
        .map(([n, posts]) => ({ _id: n, count: counts.get(n) ?? 0, posts }))
        .sort((a, b) => b.count - a.count || b.posts - a.posts)
        .map(({ _id, count }) => ({ _id, count })),
    );
  }
  return out;
}
