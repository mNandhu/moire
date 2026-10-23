// The gallery search box's terms: tags, plus loras, embeddings and outfits
// typed as `lora:name` etc., mapped to and from the Image filter. Pure.

import type { Filters } from "./imageFilter";

/** How a lora, embedding or outfit reads as a search term: `lora:name`.
 * ComfyUI's own spelling; `emb:` is accepted as short for `embedding:`. */
export const RESOURCE_PREFIXES = { lora: "lora:", embedding: "embedding:", outfit: "outfit:" } as const;
export type ResourceKind = keyof typeof RESOURCE_PREFIXES;
const TYPED_PREFIX = /^(lora|embedding|emb|outfit):\s*(.+)$/i;

/** A typed search term's lora, embedding or outfit, if it names one. Pure. */
export function resourceOf(term: string): { kind: ResourceKind; name: string } | null {
  const m = TYPED_PREFIX.exec(term.trim());
  if (!m) return null;
  const k = m[1].toLowerCase();
  return { kind: k === "lora" ? "lora" : k === "outfit" ? "outfit" : "embedding", name: m[2].trim() };
}

/** A saved outfit as the search box knows it. */
export type KnownOutfit = { id: string; name: string };

/** Everything the search box shows as chips: tags, then loras, embeddings
 * and outfits (by name; `outfits` gives the names for the ids), each as its
 * search term. Pure. */
export function searchTerms(f: Filters, outfits: readonly KnownOutfit[] = []): string[] {
  return [
    ...f.tags,
    ...f.lora.map((n) => RESOURCE_PREFIXES.lora + n),
    ...f.embedding.map((n) => RESOURCE_PREFIXES.embedding + n),
    ...f.outfit.map((id) => RESOURCE_PREFIXES.outfit + outfitName(id, outfits)),
  ];
}

/** An outfit's name for its chip; one the list doesn't name reads as its
 * id, a character's Default as "Default, <character>". Pure. */
function outfitName(id: string, outfits: readonly KnownOutfit[]): string {
  const known = outfits.find((o) => o.id === id)?.name;
  if (known) return known;
  return id.startsWith("default:") ? `Default, ${id.slice(8).replace(/_/g, " ")}` : id;
}

/**
 * `f` with the search box's chips put back where they belong: `lora:` and
 * `embedding:` terms into their lists (never into tags, whose names the
 * backend respells), the rest as tags. `known` resolves a typed name to the
 * one the library uses (`nahidaxl` is `NahidaXL`): matching is exact. Pure.
 */
export function withSearchTerms(
  f: Filters,
  terms: readonly string[],
  known: Partial<Record<"lora" | "embedding", readonly string[]>> = {},
  outfits: { list: readonly KnownOutfit[]; tags?: ReadonlySet<string> } = { list: [] },
): Filters {
  const next = { tags: [] as string[], lora: [] as string[], embedding: [] as string[], outfit: [] as string[] };
  const outfitNamed = (name: string) => {
    const lower = name.toLowerCase();
    return outfits.list.find((o) => o.name.toLowerCase() === lower);
  };
  // An outfit chip already in the filter keeps its id (a Default has no name
  // in the list): the term it shows maps back to it.
  const shown = new Map(f.outfit.map((id) => [RESOURCE_PREFIXES.outfit + outfitName(id, outfits.list), id]));
  for (const term of terms) {
    // A bare `lora:` with no name yet is nothing to search for.
    if (/^(lora|embedding|emb|outfit):\s*$/i.test(term.trim())) continue;
    const r = resourceOf(term);
    if (!r) {
      // A plain name that is an outfit, and not a tag the library has.
      const o = outfitNamed(term.trim());
      if (o && !outfits.tags?.has(term.trim().replace(/\s+/g, "_"))) {
        if (!next.outfit.includes(o.id)) next.outfit.push(o.id);
      } else next.tags.push(term);
      continue;
    }
    if (r.kind === "outfit") {
      const id = shown.get(term) ?? outfitNamed(r.name)?.id;
      if (id && !next.outfit.includes(id)) next.outfit.push(id);
      continue;
    }
    const lower = r.name.toLowerCase();
    const name = known[r.kind]?.find((k) => k.toLowerCase() === lower) ?? r.name;
    if (!next[r.kind].includes(name)) next[r.kind].push(name);
  }
  return { ...f, ...next };
}
