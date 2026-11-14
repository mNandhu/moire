/**
 * Tidying a prompt in one go: a tag written twice keeps its first place,
 * however either copy is weighted or grouped (`(masterpiece:1.1), masterpiece`),
 * with the heaviest copy's weight (`smile, (smile:1.3)` is `(smile:1.3)`),
 * and commas with nothing between them, or before the first term, or after
 * the last, go. What promptRepeats leaves alone stays (a LoRA, a side of a
 * prompt edit, a group in an `AND` prompt), as do escaped commas (`\,`).
 * Pure.
 */
import { removeTerms } from "./promptOutline";
import { topTerms } from "./promptRepeats";
import { formatWeight } from "@/features/tags/lib/tags";

export type PromptCleanup = { text: string; repeats: number; commas: number };

/** Where each `BREAK` / `AND` sits: a repeat across one is on purpose
 * (each chunk or region is read on its own). */
const SPLITS = /\b(?:BREAK|AND)\b/g;

type Span = { start: number; end: number };

/** The prompt's tags written again in the same chunk: the copies to drop,
 * and where the kept one is rewritten to carry a heavier copy's weight. The
 * first place stays; when it sits in a group (whose weight it shares) the
 * heaviest copy stays instead. */
function repeatedTerms(text: string): { drop: Span[]; reweigh: (Span & { text: string })[] } {
  const splits = [...text.matchAll(SPLITS)].map((m) => m.index);
  const chunk = (at: number) => splits.filter((s) => s < at).length;
  const copies = new Map<string, ReturnType<typeof topTerms>>();
  for (const t of topTerms(text)) {
    if (!t.key || t.kind !== "tag") continue;
    const k = `${chunk(t.start)}:${t.key}`;
    copies.set(k, [...(copies.get(k) ?? []), t]);
  }
  const drop: Span[] = [];
  const reweigh: (Span & { text: string })[] = [];
  for (const [first, ...rest] of copies.values()) {
    if (!rest.length) continue;
    const heaviest = rest.reduce((a, b) => (b.weight > a.weight ? b : a));
    if (heaviest.weight <= first.weight) drop.push(...rest);
    else if (first.grouped) drop.push(first, ...rest.filter((t) => t !== heaviest));
    else {
      drop.push(...rest);
      const name = text.slice(first.nameStart, first.nameEnd);
      reweigh.push({ start: first.start, end: first.end, text: `(${name}:${formatWeight(heaviest.weight)})` });
    }
  }
  return { drop, reweigh };
}

// A comma that isn't escaped.
const COMMA = String.raw`(?<!\\),`;
const DOUBLED = new RegExp(String.raw`${COMMA}(?:[ \t]*${COMMA})+`, "g");
const LEADING = new RegExp(String.raw`^[ \t]*(?:${COMMA}[ \t]*)+`);
const BEFORE = new RegExp(String.raw`[ \t]+(?=${COMMA})`, "g");
const ENDS_IN_COMMA = new RegExp(String.raw`${COMMA}\s*$`);

/** `text` with its stray commas gone, and how many went. */
function tidyCommas(text: string): { text: string; commas: number } {
  const count = (s: string) => (s.match(new RegExp(COMMA, "g")) ?? []).length;
  const out: string[] = [];
  // The last line with something on it, kept: a line's leading comma is its
  // separator from that one, unless there is none or it ends in its own.
  let last = "";
  for (const line of text.split("\n")) {
    let l = line.replace(DOUBLED, ",").replace(BEFORE, "");
    if (!last.trim() || ENDS_IN_COMMA.test(last)) l = l.replace(LEADING, "");
    // A line left with nothing on it but its commas goes with them.
    if (l.trim() === "" && line.trim() !== "") continue;
    out.push(l);
    if (l.trim()) last = l;
  }
  let next = out.join("\n");
  // Commas after the last term, with the space around them.
  const core = next.trimEnd();
  let cut = core;
  while (ENDS_IN_COMMA.test(cut)) cut = cut.replace(ENDS_IN_COMMA, "").trimEnd();
  if (cut !== core) next = cut;
  return { text: next, commas: count(text) - count(next) };
}

/** `text` tidied, with what changed; the same text when nothing would. */
export function cleanPrompt(text: string): PromptCleanup {
  // The kept copies take their weight first (from the end, so the earlier
  // offsets hold); read again, nothing is heavier than its first place.
  let weighed = text;
  for (const r of repeatedTerms(text).reweigh.sort((a, b) => b.start - a.start)) {
    weighed = weighed.slice(0, r.start) + r.text + weighed.slice(r.end);
  }
  const repeats = repeatedTerms(weighed).drop;
  const deduped = repeats.length ? removeTerms(weighed, repeats) : weighed;
  // removeTerms takes each term's own separator, so what's left over is
  // the writer's own strays.
  const { text: tidied, commas } = tidyCommas(deduped);
  return tidied === text ? { text, repeats: 0, commas: 0 } : { text: tidied, repeats: repeats.length, commas };
}

/** What a cleanup would do, in a few words; null when there's nothing. */
export function cleanupWords(c: PromptCleanup, changed: boolean): string | null {
  if (!changed) return null;
  const parts = [
    c.repeats && `${c.repeats} repeated ${c.repeats === 1 ? "tag" : "tags"}`,
    c.commas && `${c.commas} stray ${c.commas === 1 ? "comma" : "commas"}`,
  ].filter(Boolean);
  if (parts.length) return `Remove ${parts.join(" and ")}`;
  return "Tidy the commas";
}
