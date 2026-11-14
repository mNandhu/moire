/**
 * A character's identity tags marked where they show: hovering a character in
 * the viewer's side panel lights up the tags that make them who they are, in
 * the prompt text and in the tag runs. Pure.
 */
import type { Recipe } from "@/features/generate/lib/generate";
import { promptTerms } from "@/features/generate/lib/prompt/promptOutline";
import { canonicalName, tagName } from "@/features/tags/lib/tags";

const key = (name: string) => canonicalName(tagName(name)).toLowerCase();

/** The names to light up for a character: their tag, its aliases and the
 * identity tags the recipe keeps, in canonical lowercase spelling. */
export function identityNames(r: Pick<Recipe, "tag" | "aliases" | "identity">): Set<string> {
  return new Set([r.tag, ...r.aliases, ...r.identity.filter((x) => !x.dropped).map((x) => x.tag)].map(key));
}

/** Whether a stored tag (any kind prefix) is one of `names`. */
export const isIdentityTag = (raw: string, names: ReadonlySet<string>) => names.has(key(raw));

export type PromptSegment = { text: string; hit: boolean };

/** `text` cut into runs, those holding one of `names` (just the name, not its
 * weight or brackets) marked `hit`. Joined, the runs are `text` again. */
export function promptSegments(text: string, names: ReadonlySet<string>): PromptSegment[] {
  const out: PromptSegment[] = [];
  let at = 0;
  for (const t of promptTerms(text)) {
    if (t.kind !== "tag" || !names.has(t.name) || t.nameStart < at) continue;
    if (t.nameStart > at) out.push({ text: text.slice(at, t.nameStart), hit: false });
    out.push({ text: text.slice(t.nameStart, t.nameEnd), hit: true });
    at = t.nameEnd;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
