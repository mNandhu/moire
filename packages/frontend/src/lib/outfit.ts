/**
 * What a character wears in the composer. A pick keeps a snapshot of the
 * outfit's tags, so chip edits (drop one, add one) apply to this batch only
 * and a draft survives the outfit being edited or deleted.
 */
import type { Outfit, OutfitInput } from "./generate";
import { DEFAULT_FILTERS, serializeFilters } from "./imageFilter";
import { canonicalName } from "./tags";

/** As many tags as an outfit takes (the backend's MAX_TAGS). */
export const MAX_OUTFIT_TAGS = 40;

export type OutfitPick = {
  /** A saved outfit's id, or "default". */
  id: string;
  name: string;
  /** Its tags when picked, then any added for this batch. */
  tags: string[];
  /** Tags struck for this batch (restorable). */
  dropped: string[];
};

/** Character page key -> what they wear; absent wears nothing. */
export type Outfits = Record<string, OutfitPick>;

/** A fresh pick of `o`. Pure. */
export function pickOf(o: Pick<Outfit, "_id" | "name" | "tags">): OutfitPick {
  return { id: o._id, name: o.name, tags: o.tags.map((t) => t.tag), dropped: [] };
}

/** The tags a pick sends. Pure. */
export function wornTags(p: OutfitPick | undefined): string[] {
  if (!p) return [];
  const off = new Set(p.dropped);
  return p.tags.filter((t) => !off.has(t));
}

/** The pick with `tag` struck, or back if it was. Pure. */
export function toggleWorn(p: OutfitPick, tag: string): OutfitPick {
  return p.dropped.includes(tag)
    ? { ...p, dropped: p.dropped.filter((t) => t !== tag) }
    : { ...p, dropped: [...p.dropped, tag] };
}

/** The pick with `tag` added for this batch (once). Pure. */
export function addWorn(p: OutfitPick, tag: string): OutfitPick {
  const t = canonicalName(tag);
  if (!t) return p;
  if (p.tags.includes(t)) return { ...p, dropped: p.dropped.filter((x) => x !== t) };
  return { ...p, tags: [...p.tags, t] };
}

/** What the queue body sends for a pick; null wears nothing. Pure. */
export function outfitInput(p: OutfitPick | undefined): OutfitInput | null {
  const tags = wornTags(p);
  return p && tags.length ? { id: p.id, name: p.name, tags } : null;
}

/** Only the picks of characters still in the prompt. Pure. */
export function keepPicked(outfits: Outfits, characters: readonly string[]): Outfits {
  const out: Outfits = {};
  for (const c of characters) if (outfits[c]) out[c] = outfits[c];
  return out;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const strs = (v: unknown) => (Array.isArray(v) ? v.filter(isStr) : null);

/** Stored picks (a draft is stored data): malformed ones dropped. Pure. */
export function validOutfits(v: unknown): Outfits {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Outfits = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const tags = strs(p.tags);
    const dropped = strs(p.dropped) ?? [];
    if (isStr(p.id) && p.id && isStr(p.name) && tags) out[k] = { id: p.id, name: p.name, tags, dropped };
  }
  return out;
}

/** A batch's recorded outfit back as a pick (Edit and queue): what was sent,
 * nothing struck. Pure. */
export function pickFromInput(o: OutfitInput | null | undefined): OutfitPick | null {
  return o && isStr(o.id) && Array.isArray(o.tags) ? { id: o.id, name: o.name ?? "", tags: o.tags.filter(isStr), dropped: [] } : null;
}

/** The gallery's outfit filter for `o` (images wearing most of it), plus
 * the character when given; a Default is named by its character. Pure. */
export function outfitGalleryHref(o: Pick<Outfit, "_id" | "character">, character?: string | null): string {
  const id = o._id === "default" ? `default:${o.character}` : o._id;
  const tags = character ? [character] : [];
  return `/?${serializeFilters({ ...DEFAULT_FILTERS, tags, outfit: [id] }).toString()}`;
}
