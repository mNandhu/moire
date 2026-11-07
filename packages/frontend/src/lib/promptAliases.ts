/**
 * Every Danbooru alias in a prompt swapped for its tag in one go
 * (`blowjob` is `fellatio`), as the board's swap does one at a time: only
 * the name changes (weight, emphasis and grouping stay), and an alias whose
 * tag is already in goes instead, as the board's Remove duplicate does. Pure.
 */
import { promptTerms, removeTerms, replaceName } from "./promptOutline";

export type AliasSwap = { text: string; swapped: number };

type Places = Readonly<Record<string, { alias_of?: string }>>;

const aliasOf = (name: string, places: Places) => {
  const tag = places[name]?.alias_of;
  return tag && tag !== name ? tag : null;
};

export function swapAliases(text: string, places: Places | undefined): AliasSwap {
  if (!places) return { text, swapped: 0 };
  const tags = promptTerms(text).filter((t) => t.kind === "tag");
  const hits = tags.filter((t) => aliasOf(t.name, places));
  if (!hits.length) return { text, swapped: 0 };
  // The tag written as itself, or by an alias swapped earlier: the rest go.
  const present = new Set(tags.filter((t) => !aliasOf(t.name, places)).map((t) => t.name));
  const drop = hits.filter((t) => {
    const tag = aliasOf(t.name, places)!;
    if (present.has(tag)) return true;
    present.add(tag);
    return false;
  });
  let out = drop.length ? removeTerms(text, drop) : text;
  // From the end, so the offsets before each one still hold.
  const left = promptTerms(out).filter((t) => t.kind === "tag" && aliasOf(t.name, places));
  for (const t of [...left].reverse()) out = replaceName(out, t, aliasOf(t.name, places)!);
  return { text: out, swapped: hits.length };
}

/** The button's tooltip, null when there is nothing to swap. */
export function aliasSwapWords(s: AliasSwap): string | null {
  return s.swapped ? `Swap ${s.swapped} ${s.swapped === 1 ? "alias" : "aliases"} for ${s.swapped === 1 ? "its tag" : "their tags"}` : null;
}
