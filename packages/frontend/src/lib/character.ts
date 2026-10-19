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
  /** Colours from hair and eye tags, strongest first. */
  palette: string[];
  cover_blurhash: string | null;
  signature: Array<{ tag: string; count: number }>;
  /** Other characters on the same images. */
  with: Array<{ tag: string; count: number }>;
  best: Array<{ image_id: string; score: number; thumb_url: string }>;
  scored: { count: number; average: number | null };
  ratings: Record<string, number>;
  /** As the Tags panel's, plus the average score once enough are scored. */
  loras: Array<{ name: string; count: number; strength: number | null; score: number | null }>;
};

/** `/tags/characters`: one entry per character, aliases folded in. */
export type CharacterEntry = {
  tag: string;
  aliases: string[];
  count: number;
  thumb_url: string;
  name: string | null;
  focus: [number, number] | null;
};

/** What the user can set on a character page; "" clears a field. */
export type CharacterPatch = Partial<{
  name: string;
  series: string;
  kind: "character" | "general" | "";
  color: string;
  focus_x: number;
  focus_y: number;
}>;

export const characterHref = (tag: string) => `/characters/${encodeURIComponent(tag)}`;

/** "nahida (genshin impact)" as the name and the series it's from. */
export function characterName(tag: string): { name: string; series: string | null } {
  const shown = formatTag(tag);
  const m = /^(.+?) \((.+)\)$/.exec(shown);
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
