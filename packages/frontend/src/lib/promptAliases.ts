/**
 * Every Danbooru alias in a prompt swapped for its tag in one go
 * (`blowjob` is `fellatio`), as the board's swap does one at a time. Only the
 * name changes: weight, emphasis and grouping stay. An alias whose tag is
 * already in the prompt becomes a repeat, which Clean up then takes out.
 * Pure.
 */
import { promptTerms, replaceName } from "./promptOutline";

export type AliasSwap = { text: string; swapped: number };

export function swapAliases(text: string, places: Readonly<Record<string, { alias_of?: string }>> | undefined): AliasSwap {
  if (!places) return { text, swapped: 0 };
  const hits = promptTerms(text).filter((t) => t.kind === "tag" && places[t.name]?.alias_of && places[t.name].alias_of !== t.name);
  let out = text;
  // From the end, so the offsets before each one still hold.
  for (const t of [...hits].reverse()) out = replaceName(out, t, places[t.name].alias_of!);
  return { text: out, swapped: hits.length };
}

/** The button's tooltip, null when there is nothing to swap. */
export function aliasSwapWords(s: AliasSwap): string | null {
  return s.swapped ? `Swap ${s.swapped} ${s.swapped === 1 ? "alias" : "aliases"} for ${s.swapped === 1 ? "its tag" : "their tags"}` : null;
}
