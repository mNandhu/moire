/**
 * What a tag's own words say about colour and kind, for marking it in a tag
 * list: a hair or eye tag is outlined in its colour (`blue_eyes` blue,
 * `red_hair` red), a multicolour one (`multicolored_hair`, `heterochromia`)
 * in a rainbow, and each tag is tinted by its facet (how the character looks,
 * what they wear, their pose, the scene, the framing).
 *
 * The colour words mirror the backend's services/character_look.py `COLOURS` and
 * `colour_of` (which colour the character pages), so a character page and
 * its tags agree. Neutrals are lifted here so black hair still shows on the
 * dark canvas.
 */
import type { CSSProperties } from "react";
import { tagName } from "./tags";

/** Colour words in hair / eye tags, as `[hue, saturation %, lightness %]`. */
const COLOURS: Record<string, readonly [number, number, number]> = {
  red: [355, 70, 52],
  dark_red: [355, 60, 38],
  crimson: [350, 70, 45],
  orange: [25, 80, 55],
  yellow: [48, 85, 55],
  blonde: [44, 75, 60],
  light_brown: [28, 45, 50],
  brown: [25, 45, 38],
  green: [130, 50, 45],
  light_green: [110, 50, 60],
  dark_green: [140, 45, 30],
  aqua: [178, 60, 50],
  teal: [180, 55, 38],
  light_blue: [200, 70, 65],
  blue: [215, 70, 55],
  dark_blue: [222, 60, 35],
  purple: [275, 50, 55],
  light_purple: [275, 55, 70],
  dark_purple: [275, 45, 35],
  violet: [270, 60, 60],
  pink: [335, 70, 70],
  light_pink: [340, 70, 80],
  hot_pink: [330, 85, 60],
  magenta: [310, 70, 50],
  gold: [45, 80, 50],
  amber: [38, 85, 50],
  // Neutrals: grey-scale, lightened enough to read against the canvas.
  white: [0, 0, 92],
  silver: [220, 12, 75],
  grey: [0, 0, 60],
  gray: [0, 0, 60],
  light_grey: [0, 0, 72],
  dark_grey: [0, 0, 45],
  black: [240, 6, 38],
};

const PART = /^(.+)_(hair|eyes)$/;

/**
 * Hair and eye tags that name more than one colour. `split-color_hair` and
 * `two-tone_hair` included; a single-colour streak (`blue_streaks`) is not a
 * hair tag and stays unmarked.
 */
const MULTICOLOUR = new Set([
  "multicolored_hair",
  "multicolored_eyes",
  "gradient_hair",
  "gradient_eyes",
  "two-tone_hair",
  "split-color_hair",
  "streaked_hair",
  "rainbow_hair",
  "colored_inner_hair",
  "heterochromia",
]);

/** The colour word in a hair / eye tag (`light_blue_hair` is light blue), else null. */
export function colourWord(raw: string): string | null {
  const m = PART.exec(tagName(raw).toLowerCase());
  if (!m) return null;
  const words = m[1].split("_");
  for (const n of [2, 1]) {
    if (words.length < n) continue;
    const word = words.slice(-n).join("_");
    if (Object.prototype.hasOwnProperty.call(COLOURS, word)) return word;
  }
  return null;
}

/** A hair / eye tag's colour as CSS (`hsl(...)`), else null. */
export function tagColour(raw: string): string | null {
  const word = colourWord(raw);
  if (!word) return null;
  const [h, s, l] = COLOURS[word];
  return `hsl(${h} ${s}% ${l}%)`;
}

export function isMulticolour(raw: string): boolean {
  return MULTICOLOUR.has(tagName(raw).toLowerCase());
}

/** The backend's facets (services/attire.py `FACETS`). */
export type Facet = "look" | "outfit" | "pose" | "scene" | "framing";

export const FACET_LABEL: Record<Facet, string> = {
  look: "look",
  outfit: "outfit",
  pose: "pose and expression",
  scene: "scene",
  framing: "framing",
};

/** A wash per facet: visible on the dark panel, light enough that the text colour (the tag's kind) still reads. */
export const FACET_TINT: Record<Facet, string> = {
  look: "rgb(251 113 133 / 0.15)",
  outfit: "rgb(252 211 77 / 0.11)",
  pose: "rgb(52 211 153 / 0.11)",
  scene: "rgb(56 189 248 / 0.13)",
  framing: "rgb(167 139 250 / 0.15)",
};

const RAINBOW =
  "conic-gradient(from 90deg, hsl(355 70% 55%), hsl(45 80% 55%), hsl(130 50% 50%), hsl(200 70% 60%), hsl(275 55% 62%), hsl(330 75% 62%), hsl(355 70% 55%))";

/**
 * Inline style that marks a tag: its facet's tint (painted by
 * {@link TAG_TINT_CLASS}), and an outline in its
 * colour (a 1px ring for one colour, a rainbow border for a multicolour tag).
 * `ground` is the opaque colour behind the tag: the rainbow is a border-box
 * gradient, so the fill (ground, then tint) is painted over it inside.
 * `marks` turns either off (Settings, Tag colours). Undefined when there is
 * nothing to mark.
 */
export function tagMarkStyle(
  raw: string,
  facet: Facet | null | undefined,
  ground: string,
  marks: { outlines: boolean; tints: boolean } = { outlines: true, tints: true },
): CSSProperties | undefined {
  const tint = facet && marks.tints ? FACET_TINT[facet] : null;
  if (!marks.outlines) return tint ? ({ "--tag-tint": tint } as CSSProperties) : undefined;
  if (isMulticolour(raw)) {
    const fill = tint ? `linear-gradient(${tint}, ${tint}) padding-box, ` : "";
    return {
      border: "1px solid transparent",
      background: `${fill}linear-gradient(${ground}, ${ground}) padding-box, ${RAINBOW} border-box`,
    };
  }
  const colour = tagColour(raw);
  if (!colour && !tint) return undefined;
  // The tint goes through a custom property, not `backgroundColor`, so a
  // class can paint it and a hover class can still override it.
  return {
    ...(tint ? ({ "--tag-tint": tint } as CSSProperties) : {}),
    ...(colour ? { boxShadow: `inset 0 0 0 1px ${colour}` } : {}),
  };
}

/** The class that paints {@link tagMarkStyle}'s tint; put hover classes after it. */
export const TAG_TINT_CLASS = "bg-[color:var(--tag-tint)]";

/** Tailwind `raised`: the fill of tag chips. */
const CHIP_GROUND = "#1e1c26";

/**
 * Inline style that draws a bordered tag chip's border in the tag's colour
 * (rainbow for a multicolour tag). Undefined when the tag names no colour,
 * so the chip keeps its usual border.
 */
export function chipBorderStyle(raw: string, ground = CHIP_GROUND): CSSProperties | undefined {
  if (isMulticolour(raw)) {
    return {
      borderColor: "transparent",
      background: `linear-gradient(${ground}, ${ground}) padding-box, ${RAINBOW} border-box`,
    };
  }
  const colour = tagColour(raw);
  return colour ? { borderColor: colour } : undefined;
}
