/**
 * Character pages' pure logic: where a character links, what they're called,
 * which images are theirs, and the colours their page is lit with.
 */
import { ambientPalette } from "./blurhash";
import { DEFAULT_FILTERS, type Filters } from "./imageFilter";
import { ANY_PREFIX, formatTag } from "./tags";
import type { TagDetail } from "./tagBrowse";

/** `/tags/character`: a character page, under the name the page uses. */
export type CharacterPage = Omit<TagDetail, "loras"> & {
  /** Other names of the character (a bare `furina`), counted as one. */
  aliases: string[];
  name: string | null;
  series: string | null;
  /** The user's say: a character or not, overriding the tagger. */
  kind: "character" | "general" | null;
  /** The user's colour, `#rrggbb`. */
  color: string | null;
  /** The avatar's focus point, 0..1 from the left and top. */
  focus: [number, number] | null;
  /** The face found in the avatar: centre x / y, width / height (0..1). */
  face: Face | null;
  /** The avatar image's width / height. */
  aspect: number | null;
  /** Colours from hair and eye tags, strongest first. */
  palette: string[];
  cover_blurhash: string | null;
  signature: Array<{ tag: string; count: number }>;
  /** The images the signature was read from (solo ones when there are enough). */
  signature_images: number;
  /** Other characters on the same images. */
  with: Array<{ tag: string; count: number }>;
  best: Array<{ image_id: string; score: number; thumb_url: string }>;
  scored: { count: number; average: number | null };
  ratings: Record<string, number>;
  /** Made by hand and no image has them yet. */
  made?: boolean;
  /** As the Tags panel's, plus the average score once enough are scored. */
  loras: Array<{ name: string; count: number; strength: number | null; score: number | null }>;
};

/** `/tags/characters`: one entry per character, aliases folded in. */
export type CharacterEntry = {
  tag: string;
  aliases: string[];
  count: number;
  /** Null for a character made by hand that no image has yet. */
  thumb_url: string | null;
  /** The avatar image: the pinned one, else the one Moiré picked. */
  thumb_image_id: string | null;
  name: string | null;
  series: string | null;
  /** Their colour: the user's, else the strongest hair or eye colour. */
  color: string | null;
  focus: [number, number] | null;
  face: Face | null;
  aspect: number | null;
};

export type Face = [number, number, number, number];

/** What the user can set on a character page; "" clears a field. */
export type CharacterPatch = Partial<{
  name: string;
  series: string;
  kind: "character" | "general" | "";
  color: string;
  focus_x: number | "";
  focus_y: number | "";
}>;

/** `/tags/x`: a plain tag's page. */
export const tagHref = (tag: string) => `/tags/${encodeURIComponent(tag)}`;
export const characterHref = (tag: string) => `/characters/${encodeURIComponent(tag)}`;

/** "nahida (genshin impact)" as the name and the series it's from. One
 * trailing qualifier only, the backend's rule (tag_categories
 * `character_parts`, shared cases in tests/fixtures/mirrored/character_parts.json):
 * "a (b) (c)" is a whole name, not "a" from "b) (c". */
export function characterName(tag: string): { name: string; series: string | null } {
  const shown = formatTag(tag);
  const m = /^([^()]+) \(([^()]+)\)$/.exec(shown);
  return m ? { name: m[1], series: m[2] } : { name: shown, series: null };
}

/** The name and series a character shows, the user's over the tag's. */
export function displayName(c: {
  tag: string;
  name?: string | null;
  series?: string | null;
}): { name: string; series: string | null } {
  const fromTag = characterName(c.tag);
  return { name: c.name || fromTag.name, series: c.series || fromTag.series };
}

/** The gallery filter for everything the character is in, under any name. */
export function characterFilters(tag: string, aliases: readonly string[]): Filters {
  return {
    ...DEFAULT_FILTERS,
    tags: [tag, ...aliases].map((t) => `${ANY_PREFIX}${t}`),
    logic: aliases.length ? "or" : "and",
  };
}

/** How far around the face an avatar shows: the face's size times this. */
export const FACE_ZOOM = 2.5;

/** How far around the face a portrait card shows: its whole upper body. */
export const CARD_ZOOM = 4.5;

/**
 * How to show a character's image in a frame of `frame` shape (width /
 * height; 1 for a round avatar): as a crop of the image, given as the
 * image's size and offset in percent of the frame. A found face is zoomed
 * to (its box grown `zoom` times, the frame's short side); the user's focus
 * point moves the centre and keeps that zoom; with neither, as much as fits,
 * centred a third of the way down (portraits put the face high). Null
 * without the image's shape: plain `object-cover` then.
 */
export function avatarCrop(
  a: {
    face: Face | null;
    focus: readonly [number, number] | null;
    aspect: number | null;
  },
  frame = 1,
  zoom = FACE_ZOOM,
): { width: string; height: string; left: string; top: string } | null {
  const ratio = a.aspect;
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return null;
  // Image coordinates with the height as 1 and the width as `ratio`; the
  // crop is `w` x `h` in them, shaped like the frame.
  const fit = Math.min(1, ratio / frame);
  const faceSize = a.face ? Math.max(a.face[2] * ratio, a.face[3]) * zoom : Infinity;
  const h = Math.min(fit, faceSize / Math.min(1, frame));
  const w = h * frame;
  const cx = (a.focus?.[0] ?? a.face?.[0] ?? 0.5) * ratio;
  const cy = a.focus?.[1] ?? a.face?.[1] ?? 1 / 3;
  const left = Math.min(ratio - w, Math.max(0, cx - w / 2));
  const top = Math.min(1 - h, Math.max(0, cy - h / 2));
  const pct = (v: number) => `${+(v * 100).toFixed(2)}%`;
  return { width: pct(ratio / w), height: pct(1 / h), left: pct(-left / w), top: pct(-top / h) };
}

/** A `#rrggbb` or `hsl(h s% l%)` colour as red, green, blue (0..1). */
function rgb(colour: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const hsl = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(colour);
  if (!hsl) return null;
  const [h, s, l] = [+hsl[1], +hsl[2] / 100, +hsl[3] / 100];
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** Text that reads on a background of `colour` (`#rrggbb` or `hsl(h s% l%)`). */
export function inkOn(colour: string): "light" | "dark" {
  const c = rgb(colour);
  if (!c) return "light";
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  // Whichever of near-black and white contrasts more.
  return (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05) ? "dark" : "light";
}

/** CSS `object-position` for an avatar's focus point. */
export function focusPosition(focus: readonly [number, number] | null): string {
  if (!focus) return "50% 50%";
  const pct = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
  return `${pct(focus[0])} ${pct(focus[1])}`;
}

/**
 * The three colours a character's page is lit with: the user's colour first
 * when set, then the hair and eye colours, else the cover's own hues. Empty
 * when there is nothing to go on (the app's own wash stays).
 */
export function characterColours(c: {
  color: string | null;
  palette: readonly string[];
  cover_blurhash: string | null;
}): string[] {
  const found = c.palette.length
    ? [...c.palette]
    : ambientPalette(c.cover_blurhash ? [c.cover_blurhash] : []);
  const colours = c.color ? [c.color, ...found.filter((x) => x !== c.color)] : found;
  if (!colours.length) return [];
  return [0, 1, 2].map((i) => colours[i] ?? colours[0]);
}

/**
 * The wash for several characters at once: one colour from each (their
 * first), then their seconds, up to three. One character keeps all three of
 * their own. Pure.
 */
export function mixColours(each: readonly (readonly string[])[]): string[] {
  const lists = each.filter((c) => c.length);
  if (lists.length <= 1) return [...(lists[0] ?? [])];
  const out: string[] = [];
  for (let i = 0; out.length < 3 && lists.some((c) => i < c.length); i++) {
    for (const c of lists) if (i < c.length && out.length < 3) out.push(c[i]);
  }
  return out;
}

/** Colour choices for the edit dialog: the character's own, then a wheel. */
export const SWATCHES = [
  "#d6455a",
  "#e07a3a",
  "#e2b13c",
  "#5bb35b",
  "#3fb0a8",
  "#5aa9e6",
  "#3a6fd8",
  "#8a5cd6",
  "#d36bb0",
  "#e889a8",
  "#9a7357",
  "#a3a7b3",
] as const;

/** Under this many images, a character's look is called a guess. */
const FEW_IMAGES = 5;

/**
 * The note under a look read from only a few images, else null: a
 * character's look and identity come from what their images share, and a
 * handful of images can't tell a habit from a one-off.
 */
export function fewImagesNote(images: number): string | null {
  if (images <= 0 || images >= FEW_IMAGES) return null;
  return `Based on just ${images} ${images === 1 ? "image" : "images"}, so this may be off.`;
}
