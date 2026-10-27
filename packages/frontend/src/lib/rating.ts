import type { ImageDoc } from "./imageFilter";

/** The ratings an image can have, mildest first; "-" is unrated. Mirrors the
 * backend's image_tags.RATINGS (tests/test_mirrored_vocab.py). */
export const RATINGS = ["general", "sensitive", "questionable", "explicit"] as const;
export type Rating = (typeof RATINGS)[number];

function isRating(s: string): s is Rating {
  return (RATINGS as readonly string[]).includes(s);
}

/** The rating picker's choices: Unrated, then each rating. */
export const RATING_OPTIONS = [
  { value: "-", label: "Unrated" },
  ...RATINGS.map((r) => ({ value: r, label: r })),
];

/**
 * The rating to display for an image: the explicit `rating` if set, else the
 * highest-scoring label from the AI rating map, else "-". Pure precedence logic
 * lifted out of ImageView so it has a test surface.
 */
export function pickRating(doc: ImageDoc | null | undefined): string {
  const r = (doc?.rating || "").trim();
  if (r) return r;
  const m = doc?.ai?.rating;
  if (m && typeof m === "object") {
    let bestKey: string | null = null;
    let bestVal = -Infinity;
    for (const [k, v] of Object.entries(m)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n > bestVal) {
        bestVal = n;
        bestKey = k;
      }
    }
    if (bestKey) return bestKey;
  }
  return "-";
}

/** Badge and tile-dot colours per rating (see ratingBadgeClass/ratingDotClass). */
const RATING_STYLE: Record<Rating, { badge: string; dot: string | null }> = {
  general: { badge: "bg-emerald-900/30 border-emerald-800 text-emerald-100", dot: null },
  sensitive: { badge: "bg-amber-900/30 border-amber-800 text-amber-100", dot: "bg-amber-400" },
  questionable: { badge: "bg-orange-900/30 border-orange-800 text-orange-100", dot: "bg-orange-400" },
  explicit: { badge: "bg-red-900/30 border-red-800 text-red-100", dot: "bg-red-400" },
};

function styleOf(rating: string | null | undefined) {
  const r = (rating || "").trim();
  return isRating(r) ? RATING_STYLE[r] : undefined;
}

/** Tailwind classes for a rating badge. */
export function ratingBadgeClass(rating: string): string {
  return styleOf(rating)?.badge ?? "bg-neutral-800 border-neutral-700 text-neutral-100";
}

/**
 * Tailwind background for the small rating dot drawn on a gallery tile. A
 * badge with text is too heavy at thumbnail scale, so the tile shows colour
 * only and puts the label in the tooltip; the palette matches
 * `ratingBadgeClass` so the two readings of the same field agree.
 *
 * Returns null for ratings that aren't worth marking ("general" is the
 * unremarkable default, "-" means unrated). The tile draws nothing.
 */
export function ratingDotClass(rating: string | null | undefined): string | null {
  return styleOf(rating)?.dot ?? null;
}
