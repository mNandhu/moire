/**
 * What a character wears in the composer. A pick keeps a snapshot of the
 * outfit's tags, so chip edits (drop one, add one) apply to this batch only
 * and a draft survives the outfit being edited or deleted.
 */
import { DEFAULT_OUTFIT, DEFAULT_OUTFIT_NAME } from "./generate";
import type { DefaultOutfitPatch, Outfit, OutfitBody, OutfitInput, OutfitPrefill } from "./generate";
import { galleryHref } from "./imageFilter";
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
  /** Tags added for this batch: removing one takes it away, not strikes it. */
  added?: string[];
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

/** The pick with `tag` struck, or back if it was; one added for this
 * batch goes instead. Pure. */
export function toggleWorn(p: OutfitPick, tag: string): OutfitPick {
  if (p.added?.includes(tag)) {
    return {
      ...p,
      tags: p.tags.filter((t) => t !== tag),
      dropped: p.dropped.filter((t) => t !== tag),
      added: p.added.filter((t) => t !== tag),
    };
  }
  return p.dropped.includes(tag)
    ? { ...p, dropped: p.dropped.filter((t) => t !== tag) }
    : { ...p, dropped: [...p.dropped, tag] };
}

/** The pick with each of `tags` struck, the batch's own additions gone. Pure. */
export function strikeWorn(p: OutfitPick, tags: readonly string[]): OutfitPick {
  return tags.reduce(
    (acc, t) => (!acc.tags.includes(t) || (acc.dropped.includes(t) && !acc.added?.includes(t)) ? acc : toggleWorn(acc, t)),
    p,
  );
}

/** `cur` with `tags` back as `prev` had them (struck ones worn again, the
 * batch's own additions returned), anything done since kept. Pure. */
export function restoreWorn(cur: OutfitPick, prev: OutfitPick, tags: readonly string[]): OutfitPick {
  const back = new Set(tags);
  const all = [...prev.tags, ...cur.tags.filter((t) => !prev.tags.includes(t))];
  const added = [...new Set([...(prev.added ?? []), ...(cur.added ?? [])])].filter((t) => all.includes(t));
  return { ...cur, tags: all, dropped: cur.dropped.filter((t) => !back.has(t)), ...(added.length ? { added } : {}) };
}

/** The pick with `tag` added for this batch (once). Pure. */
export function addWorn(p: OutfitPick, tag: string): OutfitPick {
  const t = canonicalName(tag);
  if (!t) return p;
  if (p.tags.includes(t)) return { ...p, dropped: p.dropped.filter((x) => x !== t) };
  return { ...p, tags: [...p.tags, t], added: [...(p.added ?? []), t] };
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
    const added = (strs(p.added) ?? []).filter((t) => tags?.includes(t));
    if (isStr(p.id) && p.id && isStr(p.name) && tags) out[k] = { id: p.id, name: p.name, tags, dropped, ...(added.length ? { added } : {}) };
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
  return galleryHref({ tags, outfit: [id] });
}

/** The Outfits page, filtered to one character. Pure. */
export const outfitsHref = (character: string): string => `/outfits?character=${encodeURIComponent(character)}`;

// The attire groups a name is made from, main garment first; exposure and
// unlisted tags never name an outfit.
const NAME_GROUPS = [
  "fashion_style",
  "attire",
  "sexual_attire",
  "legwear",
  "headwear",
  "handwear",
  "neck_and_neckwear",
  "sleeves",
  "eyewear",
  "accessories",
];

/**
 * A name for an outfit from its tags: its two main pieces, garments before
 * accessories, the more specific tag over the one it narrows (`red_bikini`
 * over `bikini`), "Red bikini + shell necklace". Tags seen in the image
 * (`source` "image" or "added") name it before ones it only usually has.
 * Empty when nothing names it. Pure.
 */
export function suggestOutfitName(
  rows: readonly { tag: string; group: string | null; source?: string; struck?: boolean }[],
): string {
  const live = rows.filter((r) => !r.struck && r.group && NAME_GROUPS.includes(r.group));
  const seen = live.filter((r) => r.source !== "usual");
  const pool = seen.length ? seen : live;
  const tags = pool.map((r) => r.tag);
  const pieces = pool
    .filter((r) => !tags.some((t) => t !== r.tag && t.endsWith(`_${r.tag}`)))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => NAME_GROUPS.indexOf(a.r.group!) - NAME_GROUPS.indexOf(b.r.group!) || a.i - b.i)
    .slice(0, 2)
    .map(({ r }) => r.tag.replace(/_/g, " "));
  const name = pieces.join(" + ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** What the save dialog is doing: saving an image's attire as a new outfit,
 * a New outfit with no image (from their usual clothes), editing a saved
 * outfit, or editing a character's Default. */
export type OutfitMode = "from-image" | "blank" | "edit" | "default";

/** The dialog's mode for `outfit` (being edited) and `imageId` (saved from). Pure. */
export function outfitModeOf(outfit: Pick<Outfit, "_id"> | undefined, imageId: string | null): OutfitMode {
  if (outfit) return outfit._id === DEFAULT_OUTFIT ? "default" : "edit";
  return imageId ? "from-image" : "blank";
}

/** Where a dialog row came from; the chips are styled by it. */
export type OutfitRowSource = "image" | "usual" | "added";
/** `struck`: a Default's computed tag left out (restorable). */
export type OutfitRow = { tag: string; group: string | null; checkable: boolean; source: OutfitRowSource; struck?: boolean };

/** The dialog's starting fields. `cover` only where the dialog picks the
 * thumbnail (editing, or a New outfit); a save from an image uses the image. */
export type OutfitSeed = { name: string; shared: boolean; rows: OutfitRow[]; cover?: string | null };

/** The dialog's starting fields for `mode`, from the outfit being edited,
 * the image's prefill or the character's usual clothes (either may be
 * missing: then no tags). Pure. */
export function seedOutfit(
  mode: OutfitMode,
  { outfit, prefill, usual }: { outfit?: Outfit; prefill?: OutfitPrefill; usual?: Outfit },
): OutfitSeed {
  if ((mode === "edit" || mode === "default") && outfit) {
    return {
      name: outfit._id === DEFAULT_OUTFIT && outfit.name === DEFAULT_OUTFIT_NAME ? "" : outfit.name,
      shared: outfit.shared,
      rows: outfit.chips
        ? outfit.chips.map((c) => ({ ...c, source: c.added ? "added" : "image", struck: c.dropped }))
        : outfit.tags.map((t) => ({ ...t, source: "image" })),
      cover: outfit.image_id,
    };
  }
  if (mode === "blank") return { name: "", shared: false, cover: null, rows: (usual?.tags ?? []).map((t) => ({ ...t, source: "usual" })) };
  return { name: "", shared: false, rows: (prefill?.tags ?? []).map((t) => ({ ...t, source: t.source })) };
}

/** The request a Save makes: a Default's patch, a saved outfit's update, or
 * a new outfit. */
export type OutfitSavePlan =
  | { kind: "default"; body: DefaultOutfitPatch }
  | { kind: "update"; id: string; body: Partial<OutfitBody> }
  | { kind: "create"; body: OutfitBody };

/** The save dialog's request for `mode`. The cover goes only when it
 * changed; a new outfit takes the image it was saved from, else the picked
 * cover. Pure. */
export function outfitSavePlan(
  mode: OutfitMode,
  s: {
    outfit?: Outfit;
    character: string;
    imageId: string | null;
    /** The typed name; `shownName` is it or the suggested one. */
    name: string;
    shownName: string;
    rows: readonly OutfitRow[];
    shared: boolean;
    cover: string | null;
  },
): OutfitSavePlan {
  if (mode === "default") {
    return {
      kind: "default",
      body: {
        name: s.name.trim(),
        dropped: s.rows.filter((r) => r.struck).map((r) => r.tag),
        added: s.rows.filter((r) => r.source === "added").map((r) => r.tag),
        ...(s.cover !== s.outfit!.image_id ? { image_id: s.cover } : {}),
      },
    };
  }
  const body = { name: s.shownName.trim(), tags: s.rows.map((r) => r.tag), shared: s.shared };
  return s.outfit
    ? { kind: "update", id: s.outfit._id, body: s.cover !== s.outfit.image_id ? { ...body, image_id: s.cover } : body }
    : { kind: "create", body: { ...body, character: s.character, image_id: s.imageId ?? s.cover } };
}
