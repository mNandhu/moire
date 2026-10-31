/**
 * Tidying a prompt in one go: a plain tag written twice keeps its first
 * place, and commas with nothing between them, or before the first term,
 * or after the last, go. Weighted, bracketed or grouped terms are left
 * alone (a repeat there is on purpose), as are escaped commas (`\,`).
 * Terms are read by promptOutline, the board's own splitter. Pure.
 */
import { promptTerms, removeTerms } from "./promptOutline";

export type PromptCleanup = { text: string; repeats: number; commas: number };

/** Where each `BREAK` / `AND` sits: a repeat across one is on purpose
 * (each chunk or region is read on its own). */
const SPLITS = /\b(?:BREAK|AND)\b/g;

/** The prompt's plain top-level tags written again after their first
 * place in the same chunk. */
function repeatedTerms(text: string): { start: number; end: number }[] {
  const splits = [...text.matchAll(SPLITS)].map((m) => m.index);
  let next = 0;
  let seen = new Set<string>();
  const out: { start: number; end: number }[] = [];
  for (const t of promptTerms(text)) {
    for (; next < splits.length && splits[next] < t.start; next++) seen = new Set();
    const plain = !t.grouped && t.kind === "tag" && t.start === t.nameStart && t.end === t.nameEnd;
    if (!plain) continue;
    if (seen.has(t.name)) out.push({ start: t.start, end: t.end });
    else seen.add(t.name);
  }
  return out;
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
  const repeats = repeatedTerms(text);
  const deduped = repeats.length ? removeTerms(text, repeats) : text;
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
